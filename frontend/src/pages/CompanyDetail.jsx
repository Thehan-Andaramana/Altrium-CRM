import { useEffect, useState } from 'react'
import Alert from 'react-bootstrap/Alert'
import Badge from 'react-bootstrap/Badge'
import Card from 'react-bootstrap/Card'
import Col from 'react-bootstrap/Col'
import Container from 'react-bootstrap/Container'
import Form from 'react-bootstrap/Form'
import ListGroup from 'react-bootstrap/ListGroup'
import Row from 'react-bootstrap/Row'
import Spinner from 'react-bootstrap/Spinner'
import { Link, useParams } from 'react-router-dom'
import { get, patch } from '../api'
import { useAuth } from '../AuthContext.jsx'

const MANAGEMENT_ROLES = new Set(['SALES_MANAGER', 'EXECUTIVE_MANAGER', 'SYSTEM_ADMIN'])

const STATUS_BADGE_VARIANT = {
  HOT: 'warning',
  COLD: 'secondary',
}

export default function CompanyDetail() {
  const { id } = useParams()
  const { user } = useAuth()
  const canEditOwner = MANAGEMENT_ROLES.has(user?.role)

  const [company, setCompany] = useState(null)
  const [loadingCompany, setLoadingCompany] = useState(true)
  const [companyError, setCompanyError] = useState(null)

  const [contacts, setContacts] = useState([])
  const [loadingContacts, setLoadingContacts] = useState(true)

  const [leads, setLeads] = useState([])
  const [loadingLeads, setLoadingLeads] = useState(true)

  const [salesReps, setSalesReps] = useState([])
  const [savingOwner, setSavingOwner] = useState(false)
  const [ownerError, setOwnerError] = useState(null)

  useEffect(() => {
    let cancelled = false

    async function fetchCompany() {
      setLoadingCompany(true)
      setCompanyError(null)
      try {
        const data = await get(`/api/companies/${id}/`)
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

  async function handleOwnerChange(ownerId) {
    setSavingOwner(true)
    setOwnerError(null)
    try {
      const updated = await patch(`/api/companies/${id}/`, { owner: ownerId ? Number(ownerId) : null })
      setCompany(updated)
    } catch {
      setOwnerError('Failed to update owner.')
    } finally {
      setSavingOwner(false)
    }
  }

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
      <h1 className="h3 mb-3">{company.name}</h1>

      {ownerError && <Alert variant="danger">{ownerError}</Alert>}

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
          {canEditOwner ? (
            <Form.Select
              size="sm"
              value={company.owner ?? ''}
              onChange={(event) => handleOwnerChange(event.target.value)}
              disabled={savingOwner}
              aria-label="Owner"
            >
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
