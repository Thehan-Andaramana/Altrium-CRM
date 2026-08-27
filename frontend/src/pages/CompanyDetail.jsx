import { format } from 'date-fns'
import { useEffect, useState } from 'react'
import Alert from 'react-bootstrap/Alert'
import Badge from 'react-bootstrap/Badge'
import Button from 'react-bootstrap/Button'
import Card from 'react-bootstrap/Card'
import Col from 'react-bootstrap/Col'
import Container from 'react-bootstrap/Container'
import Form from 'react-bootstrap/Form'
import ListGroup from 'react-bootstrap/ListGroup'
import Modal from 'react-bootstrap/Modal'
import Row from 'react-bootstrap/Row'
import Spinner from 'react-bootstrap/Spinner'
import { Link, useParams } from 'react-router-dom'
import { get, patch, post } from '../api'
import { useAuth } from '../AuthContext.jsx'
import ArchiveButton from '../components/ArchiveButton.jsx'
import NewContactInline from '../components/NewContactInline.jsx'
import PageHeader from '../components/PageHeader.jsx'

// Company update is restricted to SALES_MANAGER/EXECUTIVE_MANAGER --
// SYSTEM_ADMIN is read-only for companies (see CompanyPermission, backend).
const MANAGER_ROLES = new Set(['SALES_MANAGER', 'EXECUTIVE_MANAGER'])

const STATUS_BADGE_VARIANT = {
  HOT: 'warning',
  COLD: 'secondary',
}

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
    <Form
      onSubmit={(event) => {
        event.preventDefault()
        onSave({ name, industry, website, owner })
      }}
    >
      <Modal.Header closeButton>
        <Modal.Title as="h2" className="h5 mb-0">
          Edit Company
        </Modal.Title>
      </Modal.Header>
      <Modal.Body>
        {error && <Alert variant="danger">{error}</Alert>}
        <Form.Group className="mb-3" controlId="edit-company-name">
          <Form.Label>Name</Form.Label>
          <Form.Control value={name} onChange={(event) => setName(event.target.value)} required />
        </Form.Group>
        <Form.Group className="mb-3" controlId="edit-company-industry">
          <Form.Label>Industry</Form.Label>
          <Form.Control value={industry} onChange={(event) => setIndustry(event.target.value)} />
        </Form.Group>
        <Form.Group className="mb-3" controlId="edit-company-website">
          <Form.Label>Website</Form.Label>
          <Form.Control type="url" value={website} onChange={(event) => setWebsite(event.target.value)} />
        </Form.Group>
        <Form.Group className="mb-3" controlId="edit-company-owner">
          <Form.Label>Owner</Form.Label>
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
            <div>{company.owner_username ?? 'Unassigned'}</div>
          )}
        </Form.Group>
        <div>
          <Form.Label className="d-block">Contacts</Form.Label>
          <NewContactInline companyId={company.id} onCreated={onContactCreated} />
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onHide} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </Modal.Footer>
    </Form>
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
    } catch {
      setError('Failed to save company.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal show={show} onHide={onHide} centered>
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
    </Modal>
  )
}

function NewLeadModal({ show, onHide, onCreated, companyId, contacts, canAssignRep, salesReps }) {
  const [contactId, setContactId] = useState('')
  const [assignedTo, setAssignedTo] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  async function handleSubmit(event) {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const payload = { company: companyId, contact: contactId ? Number(contactId) : null }
      // A rep creating their own lead is auto-assigned to themselves
      // server-side (see LeadSerializer.create) -- only a manager needs to
      // pick who it goes to.
      if (canAssignRep) {
        payload.assigned_to = Number(assignedTo)
      }
      await post('/api/leads/', payload)
      onCreated()
      onHide()
    } catch {
      setError('Failed to create lead.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal show={show} onHide={onHide} centered>
      <Form onSubmit={handleSubmit}>
        <Modal.Header closeButton>
          <Modal.Title as="h2" className="h5 mb-0">
            New Lead
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {error && <Alert variant="danger">{error}</Alert>}
          <Form.Group className="mb-3" controlId="new-lead-contact">
            <Form.Label>Contact</Form.Label>
            <Form.Select value={contactId} onChange={(event) => setContactId(event.target.value)}>
              <option value="">No contact</option>
              {contacts.map((contact) => (
                <option key={contact.id} value={contact.id}>
                  {contact.name}
                </option>
              ))}
            </Form.Select>
          </Form.Group>
          {canAssignRep && (
            <Form.Group controlId="new-lead-assigned">
              <Form.Label>Assigned rep</Form.Label>
              <Form.Select value={assignedTo} onChange={(event) => setAssignedTo(event.target.value)} required>
                <option value="">Select a rep…</option>
                {salesReps.map((rep) => (
                  <option key={rep.id} value={rep.id}>
                    {rep.username}
                  </option>
                ))}
              </Form.Select>
            </Form.Group>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={onHide} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={saving || (canAssignRep && !assignedTo)}>
            {saving ? 'Creating…' : 'Create'}
          </Button>
        </Modal.Footer>
      </Form>
    </Modal>
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
    } catch {
      setError('Failed to create contact.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal show={show} onHide={onHide} centered>
      <Form onSubmit={handleSubmit}>
        <Modal.Header closeButton>
          <Modal.Title as="h2" className="h5 mb-0">
            New Contact
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {error && <Alert variant="danger">{error}</Alert>}
          <Form.Group className="mb-3" controlId="new-contact-name">
            <Form.Label>Name</Form.Label>
            <Form.Control value={name} onChange={(event) => setName(event.target.value)} required />
          </Form.Group>
          <Form.Group className="mb-3" controlId="new-contact-job-title">
            <Form.Label>Job title</Form.Label>
            <Form.Control value={jobTitle} onChange={(event) => setJobTitle(event.target.value)} />
          </Form.Group>
          <Form.Group className="mb-3" controlId="new-contact-email">
            <Form.Label>Email</Form.Label>
            <Form.Control type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
          </Form.Group>
          <Form.Group controlId="new-contact-phone">
            <Form.Label>Phone</Form.Label>
            <Form.Control value={phone} onChange={(event) => setPhone(event.target.value)} />
          </Form.Group>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={onHide} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={saving}>
            {saving ? 'Creating…' : 'Create'}
          </Button>
        </Modal.Footer>
      </Form>
    </Modal>
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
    <Container style={{ maxWidth: '56rem' }}>
      <PageHeader
        title={company.name}
        badge={
          company.is_archived && (
            <Badge bg="secondary" className="align-middle">
              Archived
            </Badge>
          )
        }
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
          <div>{company.owner_username ?? 'Unassigned'}</div>
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
                    <ListGroup.Item key={contact.id}>
                      <div>
                        {contact.name}
                        {contact.job_title && <span className="text-body-secondary"> · {contact.job_title}</span>}
                      </div>
                      <div className="text-body-secondary small">
                        {contact.email || '—'}
                        {contact.phone && <> · {contact.phone}</>}
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
                              {lead.contact_name ?? `Lead #${lead.id}`}
                            </Link>
                            <div className="text-body-secondary small">
                              {lead.assigned_to_username ?? 'Unassigned'}
                              {lead.deal_stage && <> · {lead.deal_stage}</>}
                              {phaseLabel && <> · {phaseLabel}</>}
                            </div>
                          </div>
                          <div className="d-flex align-items-center gap-1 flex-shrink-0">
                            <Badge bg={STATUS_BADGE_VARIANT[lead.status] ?? 'secondary'}>{lead.status}</Badge>
                            {lead.has_project && <Badge bg="info">Project</Badge>}
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
