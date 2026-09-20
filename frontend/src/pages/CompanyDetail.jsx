import { format } from 'date-fns'
import { Building2, GitBranch, UserPlus } from 'lucide-react'
import { useEffect, useState } from 'react'
import Alert from 'react-bootstrap/Alert'
import Button from 'react-bootstrap/Button'
import Card from 'react-bootstrap/Card'
import Col from 'react-bootstrap/Col'
import Container from 'react-bootstrap/Container'
import Form from 'react-bootstrap/Form'
import ListGroup from 'react-bootstrap/ListGroup'
import Row from 'react-bootstrap/Row'
import Spinner from 'react-bootstrap/Spinner'
import { Link, useParams } from 'react-router-dom'
import { errorMessage, get, patch, post } from '../api'
import { useAuth } from '../AuthContext.jsx'
import ArchiveButton from '../components/ArchiveButton.jsx'
import AppModal from '../components/AppModal.jsx'
import Avatar, { PersonCell } from '../components/Avatar.jsx'
import ContactDetails from '../components/ContactDetails.jsx'
import FormField, { FieldRow } from '../components/FormField.jsx'
import NewContactInline from '../components/NewContactInline.jsx'
import PageHeader from '../components/PageHeader.jsx'
import StatusPill, { LEAD_STATUS_TONE } from '../components/StatusPill.jsx'

// Company update is restricted to SALES_MANAGER/EXECUTIVE_MANAGER --
// SYSTEM_ADMIN is read-only for companies (see CompanyPermission, backend).
const MANAGER_ROLES = new Set(['SALES_MANAGER', 'EXECUTIVE_MANAGER'])

function formatWebsiteDomain(url) {
  return url.replace(/^https?:\/\//, '').replace(/^www\./, '')
}

function EditCompanyForm({ company, canEditOwner, salesReps, saving, error, onSave, onHide, onContactCreated }) {
  // Keyed by company.id from the parent, so reopening remounts this with
  // fresh initial state instead of needing an effect to resync it.
  const [name, setName] = useState(company.name)
  const [industry, setIndustry] = useState(company.industry ?? '')
  const [website, setWebsite] = useState(company.website ?? '')
  const [owner, setOwner] = useState(company.owner ?? '')

  return (
    <AppModal
      onHide={onHide}
      size="lg"
      icon={Building2}
      title="Edit Company"
      subtitle="Change the organisation's details, its owner and its contacts."
      onSubmit={(event) => {
        event.preventDefault()
        onSave({ name, industry, website, owner })
      }}
      actions={
        <>
          <Button variant="outline-secondary" onClick={onHide} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      {error && <Alert variant="danger">{error}</Alert>}
      <FieldRow>
        <FormField label="Name" controlId="edit-company-name" required key="name">
          <Form.Control value={name} onChange={(event) => setName(event.target.value)} required />
        </FormField>
        <FormField label="Industry" controlId="edit-company-industry" key="industry">
          <Form.Control value={industry} onChange={(event) => setIndustry(event.target.value)} />
        </FormField>
      </FieldRow>
      <FieldRow>
        <FormField label="Website" controlId="edit-company-website" key="website">
          <Form.Control type="url" value={website} onChange={(event) => setWebsite(event.target.value)} />
        </FormField>
        <FormField label="Owner" controlId="edit-company-owner" key="owner">
          {canEditOwner ? (
            <Form.Select value={owner} onChange={(event) => setOwner(event.target.value)}>
              <option value="">Unassigned</option>
              {salesReps.map((rep) => (
                <option key={rep.id} value={rep.id}>
                  {rep.username}
                </option>
              ))}
            </Form.Select>
          ) : (
            <div>
              <PersonCell name={company.owner_username} fallback="Unassigned" />
            </div>
          )}
        </FormField>
      </FieldRow>
      <FormField label="Contacts" controlId="edit-company-contacts">
        <NewContactInline companyId={company.id} onCreated={onContactCreated} />
      </FormField>
    </AppModal>
  )
}

function EditCompanyModal({ show, company, canEditOwner, salesReps, onHide, onSaved, onContactCreated }) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  async function handleSave({ name, industry, website, owner }) {
    setSaving(true)
    setError(null)
    try {
      const payload = { name, industry, website }
      if (canEditOwner) {
        payload.owner = owner ? Number(owner) : null
      }
      const updated = await patch(`/api/companies/${company.id}/`, payload)
      onSaved(updated)
      onHide()
    } catch (err) {
      setError(errorMessage(err, 'Failed to save company.'))
    } finally {
      setSaving(false)
    }
  }

  // The form owns the dialog, so the key below gives a different company
  // fresh fields rather than the previous one's.
  if (!show) {
    return null
  }
  return (
    <EditCompanyForm
      key={company.id}
      company={company}
      canEditOwner={canEditOwner}
      salesReps={salesReps}
      saving={saving}
      error={error}
      onSave={handleSave}
      onHide={onHide}
      onContactCreated={onContactCreated}
    />
  )
}

function NewLeadModal({ show, onHide, onCreated, companyId, contacts, canAssignRep, salesReps }) {
  const [name, setName] = useState('')
  const [contactId, setContactId] = useState('')
  const [assignedTo, setAssignedTo] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  async function handleSubmit(event) {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const payload = { name, company: companyId, contact: contactId ? Number(contactId) : null }
      // A rep creating their own lead is auto-assigned to themselves
      // server-side (see LeadSerializer.create) -- only a manager needs to
      // pick who it goes to.
      if (canAssignRep) {
        payload.assigned_to = Number(assignedTo)
      }
      await post('/api/leads/', payload)
      onCreated()
      onHide()
    } catch (err) {
      setError(errorMessage(err, 'Failed to create lead.'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <AppModal
      show={show}
      onHide={onHide}
      size="lg"
      icon={GitBranch}
      title="New Lead"
      subtitle="Start a piece of work for this company and hand it to a rep."
      onSubmit={handleSubmit}
      actions={
        <>
          <Button variant="outline-secondary" onClick={onHide} disabled={saving}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={saving || !name.trim() || (canAssignRep && !assignedTo)}
          >
            {saving ? 'Creating…' : 'Create'}
          </Button>
        </>
      }
    >
      {error && <Alert variant="danger">{error}</Alert>}
      <FormField label="Name" controlId="new-lead-name" required>
        <Form.Control
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="e.g. Wayne Enterprises — Q3 infrastructure upgrade"
          required
        />
      </FormField>
      <FieldRow>
        <FormField label="Contact" controlId="new-lead-contact" key="contact">
          <Form.Select value={contactId} onChange={(event) => setContactId(event.target.value)}>
            <option value="">No contact</option>
            {contacts.map((contact) => (
              <option key={contact.id} value={contact.id}>
                {contact.name}
              </option>
            ))}
          </Form.Select>
        </FormField>
        {canAssignRep ? (
          <FormField
            label="Assigned rep"
            controlId="new-lead-assigned"
            required
            hint="A lead is always carried by a sales rep."
            key="assigned"
          >
            <Form.Select value={assignedTo} onChange={(event) => setAssignedTo(event.target.value)} required>
              <option value="">Select a rep…</option>
              {salesReps.map((rep) => (
                <option key={rep.id} value={rep.id}>
                  {rep.username}
                </option>
              ))}
            </Form.Select>
          </FormField>
        ) : null}
      </FieldRow>
    </AppModal>
  )
}

function NewContactModal({ show, onHide, onCreated, companyId }) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [jobTitle, setJobTitle] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  async function handleSubmit(event) {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const created = await post('/api/contacts/', {
        company: companyId,
        name,
        email,
        phone,
        job_title: jobTitle,
      })
      onCreated(created)
      onHide()
    } catch (err) {
      setError(errorMessage(err, 'Failed to create contact.'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <AppModal
      show={show}
      onHide={onHide}
      size="lg"
      icon={UserPlus}
      title="New Contact"
      subtitle="Add someone at this company you can reach out to."
      onSubmit={handleSubmit}
      actions={
        <>
          <Button variant="outline-secondary" onClick={onHide} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={saving}>
            {saving ? 'Creating…' : 'Create'}
          </Button>
        </>
      }
    >
      {error && <Alert variant="danger">{error}</Alert>}
      <FieldRow>
        <FormField label="Name" controlId="new-contact-name" required key="name">
          <Form.Control value={name} onChange={(event) => setName(event.target.value)} required />
        </FormField>
        <FormField label="Job title" controlId="new-contact-job-title" key="job-title">
          <Form.Control value={jobTitle} onChange={(event) => setJobTitle(event.target.value)} />
        </FormField>
      </FieldRow>
      <FieldRow>
        <FormField label="Email" controlId="new-contact-email" key="email">
          <Form.Control type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
        </FormField>
        <FormField label="Phone" controlId="new-contact-phone" key="phone">
          <Form.Control value={phone} onChange={(event) => setPhone(event.target.value)} />
        </FormField>
      </FieldRow>
    </AppModal>
  )
}

export default function CompanyDetail() {
  const { id } = useParams()
  const { user } = useAuth()
  const canEditOwner = MANAGER_ROLES.has(user?.role)

  const [company, setCompany] = useState(null)
  const [loadingCompany, setLoadingCompany] = useState(true)
  const [companyError, setCompanyError] = useState(null)

  const [contacts, setContacts] = useState([])
  const [loadingContacts, setLoadingContacts] = useState(true)

  const [leads, setLeads] = useState([])
  const [loadingLeads, setLoadingLeads] = useState(true)

  const [projects, setProjects] = useState([])

  const [salesReps, setSalesReps] = useState([])
  const [showEditModal, setShowEditModal] = useState(false)
  const [showNewLeadModal, setShowNewLeadModal] = useState(false)
  const [showNewContactModal, setShowNewContactModal] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)

  // A rep manages (edits, and adds leads/contacts to) a company they own OR
  // have an assigned lead against -- mirrors the backend's CompanyPermission
  // (edit) and the ?mine=true set (see Companies.jsx) exactly, so the UI
  // never offers an action the API would then 403 on.
  const canManageCompany =
    Boolean(company) &&
    (canEditOwner || (user?.role === 'SALES_REP' && (company.owner === user.id || leads.length > 0)))

  useEffect(() => {
    let cancelled = false

    async function fetchCompany() {
      setLoadingCompany(true)
      setCompanyError(null)
      try {
        const data = await get(`/api/companies/${id}/?include_archived=true`)
        if (!cancelled) setCompany(data)
      } catch {
        if (!cancelled) setCompanyError('Failed to load company.')
      } finally {
        if (!cancelled) setLoadingCompany(false)
      }
    }

    fetchCompany()
    return () => {
      cancelled = true
    }
  }, [id])

  async function refreshCompany() {
    const data = await get(`/api/companies/${id}/?include_archived=true`)
    setCompany(data)
  }

  useEffect(() => {
    let cancelled = false

    async function fetchContacts() {
      setLoadingContacts(true)
      try {
        const data = await get(`/api/contacts/?company=${id}`)
        if (!cancelled) setContacts(data)
      } catch {
        if (!cancelled) setContacts([])
      } finally {
        if (!cancelled) setLoadingContacts(false)
      }
    }

    fetchContacts()
    return () => {
      cancelled = true
    }
  }, [id])

  useEffect(() => {
    let cancelled = false

    async function fetchLeadsAndProjects() {
      setLoadingLeads(true)
      try {
        const [leadsData, projectsData] = await Promise.all([
          get(`/api/leads/?company=${id}`),
          get(`/api/projects/?company=${id}`),
        ])
        if (!cancelled) {
          setLeads(leadsData)
          setProjects(projectsData)
        }
      } catch {
        if (!cancelled) {
          setLeads([])
          setProjects([])
        }
      } finally {
        if (!cancelled) setLoadingLeads(false)
      }
    }

    fetchLeadsAndProjects()
    return () => {
      cancelled = true
    }
  }, [id, refreshKey])

  useEffect(() => {
    if (!canEditOwner) {
      return
    }

    let cancelled = false

    async function fetchSalesReps() {
      try {
        const data = await get('/api/users/?role=SALES_REP')
        if (!cancelled) setSalesReps(data)
      } catch {
        // Owner dropdown just falls back to "no reps available".
      }
    }

    fetchSalesReps()
    return () => {
      cancelled = true
    }
  }, [canEditOwner])

  if (loadingCompany) {
    return (
      <div className="d-flex justify-content-center py-5">
        <Spinner animation="border" role="status">
          <span className="visually-hidden">Loading…</span>
        </Spinner>
      </div>
    )
  }

  if (companyError) {
    return <Alert variant="danger">{companyError}</Alert>
  }

  const projectByLeadId = new Map(projects.map((project) => [project.lead, project]))

  function phaseProgressLabel(lead) {
    const project = projectByLeadId.get(lead.id)
    if (!project) {
      return null
    }
    const percent = project.phase_progress?.[project.current_phase]?.percent ?? 0
    return `Phase ${project.current_phase} · ${percent}%`
  }

  return (
    <Container className="px-0" style={{ maxWidth: '56rem' }}>
      <PageHeader
        title={company.name}
        badge={company.is_archived ? 'Archived' : null}
        breadcrumbs={[{ label: 'Companies', to: '/companies' }]}
        subtitle={company.industry || null}
        actions={
          <>
            {canManageCompany && (
              <Button variant="outline-secondary" size="sm" onClick={() => setShowEditModal(true)}>
                Edit
              </Button>
            )}
            <ArchiveButton resource="company" record={company} onArchived={refreshCompany} label="Archive company" />
          </>
        }
      />

      {canManageCompany && showEditModal && (
        <EditCompanyModal
          show={showEditModal}
          company={company}
          canEditOwner={canEditOwner}
          salesReps={salesReps}
          onHide={() => setShowEditModal(false)}
          onSaved={setCompany}
          onContactCreated={(contact) => setContacts((prev) => [...prev, contact])}
        />
      )}

      {canManageCompany && showNewLeadModal && (
        <NewLeadModal
          show={showNewLeadModal}
          onHide={() => setShowNewLeadModal(false)}
          onCreated={() => setRefreshKey((k) => k + 1)}
          companyId={company.id}
          contacts={contacts}
          canAssignRep={canEditOwner}
          salesReps={salesReps}
        />
      )}

      {canManageCompany && showNewContactModal && (
        <NewContactModal
          show={showNewContactModal}
          onHide={() => setShowNewContactModal(false)}
          onCreated={(contact) => setContacts((prev) => [...prev, contact])}
          companyId={company.id}
        />
      )}

      <Row className="g-4 mb-4">
        <Col sm={4}>
          <div className="text-body-secondary small">Website</div>
          <div>
            {company.website ? (
              <a
                href={company.website}
                target="_blank"
                rel="noreferrer"
                className="text-decoration-none table-link-hover"
              >
                {formatWebsiteDomain(company.website)}
              </a>
            ) : (
              '—'
            )}
          </div>
        </Col>
        <Col sm={4}>
          <div className="text-body-secondary small">Created</div>
          <div>{company.created_at ? format(new Date(company.created_at), 'd MMM yyyy') : '—'}</div>
        </Col>
        <Col sm={4}>
          <div className="text-body-secondary small">Owner</div>
          <div>
            <PersonCell name={company.owner_username} fallback="Unassigned" />
          </div>
        </Col>
      </Row>

      <Row className="g-3 align-items-stretch">
        <Col md={6}>
          <Card className="h-100">
            <Card.Header className="d-flex justify-content-between align-items-center">
              <span className="fw-semibold">Contacts</span>
              {canManageCompany && (
                <Button size="sm" variant="outline-primary" onClick={() => setShowNewContactModal(true)}>
                  New Contact
                </Button>
              )}
            </Card.Header>
            <Card.Body className="p-0">
              {loadingContacts ? (
                <div className="d-flex justify-content-center py-4">
                  <Spinner animation="border" role="status" size="sm">
                    <span className="visually-hidden">Loading…</span>
                  </Spinner>
                </div>
              ) : contacts.length === 0 ? (
                <div className="text-center p-4">
                  <p className="text-body-secondary mb-2">No contacts yet.</p>
                  {canManageCompany && (
                    <Button size="sm" variant="outline-primary" onClick={() => setShowNewContactModal(true)}>
                      New Contact
                    </Button>
                  )}
                </div>
              ) : (
                <ListGroup variant="flush">
                  {contacts.map((contact) => (
                    <ListGroup.Item key={contact.id} className="d-flex align-items-start gap-2">
                      <Avatar name={contact.name} />
                      <div style={{ minWidth: 0 }}>
                        <div>
                          {contact.name}
                          {contact.job_title && (
                            <span className="text-body-secondary"> · {contact.job_title}</span>
                          )}
                        </div>
                        {contact.email || contact.phone ? (
                          <ContactDetails email={contact.email} phone={contact.phone} name={contact.name} />
                        ) : (
                          <div className="text-body-secondary small">No contact details.</div>
                        )}
                      </div>
                    </ListGroup.Item>
                  ))}
                </ListGroup>
              )}
            </Card.Body>
          </Card>
        </Col>

        <Col md={6}>
          <Card className="h-100">
            <Card.Header className="d-flex justify-content-between align-items-center">
              <span className="fw-semibold">Leads</span>
              {canManageCompany && (
                <Button size="sm" variant="outline-primary" onClick={() => setShowNewLeadModal(true)}>
                  New Lead
                </Button>
              )}
            </Card.Header>
            <Card.Body className="p-0">
              {loadingLeads ? (
                <div className="d-flex justify-content-center py-4">
                  <Spinner animation="border" role="status" size="sm">
                    <span className="visually-hidden">Loading…</span>
                  </Spinner>
                </div>
              ) : leads.length === 0 ? (
                <div className="text-center p-4">
                  <p className="text-body-secondary mb-2">No leads yet.</p>
                  {canManageCompany && (
                    <Button size="sm" variant="outline-primary" onClick={() => setShowNewLeadModal(true)}>
                      New Lead
                    </Button>
                  )}
                </div>
              ) : (
                <ListGroup variant="flush">
                  {leads.map((lead) => {
                    const phaseLabel = phaseProgressLabel(lead)
                    return (
                      <ListGroup.Item key={lead.id}>
                        <div className="d-flex justify-content-between align-items-start gap-2">
                          <div>
                            <Link
                              to={`/leads/${lead.id}`}
                              className="text-decoration-none table-link-hover fw-semibold"
                            >
                              {lead.name}
                            </Link>
                            <div className="text-body-secondary small">
                              {lead.contact_name ?? 'No contact'}
                              {' · '}
                              {lead.assigned_to_username ?? 'Unassigned'}
                              {phaseLabel && <> · {phaseLabel}</>}
                            </div>
                          </div>
                          <div className="d-flex align-items-center gap-1 flex-shrink-0">
                            <StatusPill tone={LEAD_STATUS_TONE[lead.status] ?? 'grey'}>{lead.status}</StatusPill>
                            {lead.has_project && <StatusPill tone="blue">Project</StatusPill>}
                          </div>
                        </div>
                      </ListGroup.Item>
                    )
                  })}
                </ListGroup>
              )}
            </Card.Body>
          </Card>
        </Col>
      </Row>
    </Container>
  )
}
