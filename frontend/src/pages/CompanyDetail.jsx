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
import { get, patch } from '../api'
import { useAuth } from '../AuthContext.jsx'
import ArchiveButton from '../components/ArchiveButton.jsx'
import NewContactInline from '../components/NewContactInline.jsx'

// Company update is restricted to SALES_MANAGER/EXECUTIVE_MANAGER --
// SYSTEM_ADMIN is read-only for companies (see CompanyPermission, backend).
const MANAGER_ROLES = new Set(['SALES_MANAGER', 'EXECUTIVE_MANAGER'])

const STATUS_BADGE_VARIANT = {
  HOT: 'warning',
  COLD: 'secondary',
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

  const [salesReps, setSalesReps] = useState([])
  const [showEditModal, setShowEditModal] = useState(false)

  const canEdit =
    Boolean(company) &&
    (canEditOwner || (user?.role === 'SALES_REP' && company.owner === user.id))

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

    async function fetchLeads() {
      setLoadingLeads(true)
      try {
        const data = await get(`/api/leads/?company=${id}`)
        if (!cancelled) setLeads(data)
      } catch {
        if (!cancelled) setLeads([])
      } finally {
        if (!cancelled) setLoadingLeads(false)
      }
    }

    fetchLeads()
    return () => {
      cancelled = true
    }
  }, [id])

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

  return (
    <Container style={{ maxWidth: '56rem' }}>
      <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
        <h1 className="h3 mb-0">
          {company.name}
          {company.is_archived && (
            <Badge bg="secondary" className="ms-2 align-middle">
              Archived
            </Badge>
          )}
        </h1>
        <div className="d-flex align-items-center gap-2">
          {canEdit && (
            <Button variant="outline-secondary" size="sm" onClick={() => setShowEditModal(true)}>
              Edit
            </Button>
          )}
          <ArchiveButton resource="company" record={company} onArchived={refreshCompany} />
        </div>
      </div>

      {canEdit && showEditModal && (
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

      <Row className="mb-4 gy-3">
        <Col sm={6} md={3}>
          <div className="text-body-secondary small">Industry</div>
          <div>{company.industry || '—'}</div>
        </Col>
        <Col sm={6} md={3}>
          <div className="text-body-secondary small">Website</div>
          <div>
            {company.website ? (
              <a href={company.website} target="_blank" rel="noreferrer">
                {company.website}
              </a>
            ) : (
              '—'
            )}
          </div>
        </Col>
        <Col sm={6} md={3}>
          <div className="text-body-secondary small">Created</div>
          <div>{company.created_at ? new Date(company.created_at).toLocaleDateString() : '—'}</div>
        </Col>
        <Col sm={6} md={3}>
          <div className="text-body-secondary small">Owner</div>
          <div>{company.owner_username ?? 'Unassigned'}</div>
        </Col>
      </Row>

      <Row className="g-3">
        <Col md={5}>
          <Card>
            <Card.Header>Contacts</Card.Header>
            <Card.Body className="p-0">
              {loadingContacts ? (
                <div className="d-flex justify-content-center py-4">
                  <Spinner animation="border" role="status" size="sm">
                    <span className="visually-hidden">Loading…</span>
                  </Spinner>
                </div>
              ) : contacts.length === 0 ? (
                <p className="text-body-secondary p-3 mb-0">No contacts yet.</p>
              ) : (
                <ListGroup variant="flush">
                  {contacts.map((contact) => (
                    <ListGroup.Item key={contact.id}>
                      <div>{contact.name}</div>
                      <div className="text-body-secondary small">
                        {contact.job_title || '—'}
                        {contact.email && <> · {contact.email}</>}
                        {contact.phone && <> · {contact.phone}</>}
                      </div>
                    </ListGroup.Item>
                  ))}
                </ListGroup>
              )}
            </Card.Body>
          </Card>
        </Col>

        <Col md={7}>
          <Card>
            <Card.Header>Leads</Card.Header>
            <Card.Body className="p-0">
              {loadingLeads ? (
                <div className="d-flex justify-content-center py-4">
                  <Spinner animation="border" role="status" size="sm">
                    <span className="visually-hidden">Loading…</span>
                  </Spinner>
                </div>
              ) : leads.length === 0 ? (
                <p className="text-body-secondary p-3 mb-0">No leads yet.</p>
              ) : (
                <ListGroup variant="flush">
                  {leads.map((lead) => (
                    <ListGroup.Item key={lead.id}>
                      <div className="d-flex justify-content-between align-items-start gap-2">
                        <div>
                          <Link to={`/leads/${lead.id}`}>{lead.contact_name ?? `Lead #${lead.id}`}</Link>
                          <div className="text-body-secondary small">
                            {lead.assigned_to_username ?? 'Unassigned'}
                            {lead.deal_stage && <> · {lead.deal_stage}</>}
                          </div>
                        </div>
                        <div className="d-flex flex-column align-items-end gap-1">
                          <Badge bg={STATUS_BADGE_VARIANT[lead.status] ?? 'secondary'}>{lead.status}</Badge>
                          {lead.has_project && <Badge bg="info">Project</Badge>}
                        </div>
                      </div>
                    </ListGroup.Item>
                  ))}
                </ListGroup>
              )}
            </Card.Body>
          </Card>
        </Col>
      </Row>
    </Container>
  )
}
