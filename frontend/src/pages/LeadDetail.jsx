import { formatDistanceToNow } from 'date-fns'
import { useEffect, useState } from 'react'
import Alert from 'react-bootstrap/Alert'
import Badge from 'react-bootstrap/Badge'
import Button from 'react-bootstrap/Button'
import Card from 'react-bootstrap/Card'
import Col from 'react-bootstrap/Col'
import Container from 'react-bootstrap/Container'
import Form from 'react-bootstrap/Form'
import ListGroup from 'react-bootstrap/ListGroup'
import Row from 'react-bootstrap/Row'
import Spinner from 'react-bootstrap/Spinner'
import { useParams } from 'react-router-dom'
import { get, post } from '../api'

const STATUS_BADGE_VARIANT = {
  HOT: 'warning',
  COLD: 'secondary',
}

const TYPE_OPTIONS = [
  { value: 'CALL', label: 'Call' },
  { value: 'EMAIL', label: 'Email' },
  { value: 'MEETING', label: 'Meeting' },
  { value: 'NOTE', label: 'Note' },
]

export default function LeadDetail() {
  const { id } = useParams()

  const [lead, setLead] = useState(null)
  const [loadingLead, setLoadingLead] = useState(true)
  const [leadError, setLeadError] = useState(null)

  const [interactions, setInteractions] = useState([])
  const [loadingInteractions, setLoadingInteractions] = useState(true)
  const [interactionsError, setInteractionsError] = useState(null)

  const [type, setType] = useState('CALL')
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState(null)

  useEffect(() => {
    let cancelled = false

    async function fetchLead() {
      setLoadingLead(true)
      setLeadError(null)
      try {
        const data = await get(`/api/leads/${id}/`)
        if (!cancelled) setLead(data)
      } catch {
        if (!cancelled) setLeadError('Failed to load lead.')
      } finally {
        if (!cancelled) setLoadingLead(false)
      }
    }

    fetchLead()
    return () => {
      cancelled = true
    }
  }, [id])

  useEffect(() => {
    let cancelled = false

    async function fetchInteractions() {
      setLoadingInteractions(true)
      setInteractionsError(null)
      try {
        const data = await get(`/api/interactions/?lead=${id}`)
        if (!cancelled) setInteractions(data)
      } catch {
        if (!cancelled) setInteractionsError('Failed to load interactions.')
      } finally {
        if (!cancelled) setLoadingInteractions(false)
      }
    }

    fetchInteractions()
    return () => {
      cancelled = true
    }
  }, [id])

  async function handleSubmit(event) {
    event.preventDefault()
    setSubmitting(true)
    setSubmitError(null)
    try {
      await post('/api/interactions/', { lead: Number(id), type, notes })
      setNotes('')
      const [leadData, interactionsData] = await Promise.all([
        get(`/api/leads/${id}/`),
        get(`/api/interactions/?lead=${id}`),
      ])
      setLead(leadData)
      setInteractions(interactionsData)
    } catch {
      setSubmitError('Failed to log interaction.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Container style={{ maxWidth: '48rem' }}>
      {loadingLead ? (
        <div className="d-flex justify-content-center py-5">
          <Spinner animation="border" role="status">
            <span className="visually-hidden">Loading…</span>
          </Spinner>
        </div>
      ) : leadError ? (
        <Alert variant="danger">{leadError}</Alert>
      ) : (
        <>
          <div className="d-flex flex-wrap justify-content-between align-items-start gap-2 mb-3">
            <div>
              <h1 className="h3 mb-1">{lead.company_name ?? '—'}</h1>
              <p className="text-body-secondary mb-0">{lead.contact_name ?? 'No contact'}</p>
            </div>
            <Badge bg={STATUS_BADGE_VARIANT[lead.status] ?? 'secondary'} className="fs-6">
              {lead.status}
            </Badge>
          </div>

          <Row className="mb-4 gy-2">
            <Col sm={4}>
              <div className="text-body-secondary small">Assigned to</div>
              <div>{lead.assigned_to_username ?? 'Unassigned'}</div>
            </Col>
            <Col sm={4}>
              <div className="text-body-secondary small">Last activity</div>
              <div>
                {lead.last_activity_at
                  ? formatDistanceToNow(new Date(lead.last_activity_at), { addSuffix: true })
                  : '—'}
              </div>
            </Col>
            <Col sm={4}>
              <div className="text-body-secondary small">Interactions</div>
              <div>{lead.interaction_count ?? 0}</div>
            </Col>
          </Row>

          <Card className="mb-4">
            <Card.Body>
              <Card.Title as="h2" className="h5">
                Log interaction
              </Card.Title>
              {submitError && <Alert variant="danger">{submitError}</Alert>}
              <Form onSubmit={handleSubmit}>
                <Row className="g-2 align-items-end">
                  <Col sm={3}>
                    <Form.Group controlId="interaction-type">
                      <Form.Label>Type</Form.Label>
                      <Form.Select value={type} onChange={(event) => setType(event.target.value)}>
                        {TYPE_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </Form.Select>
                    </Form.Group>
                  </Col>
                  <Col sm={7}>
                    <Form.Group controlId="interaction-notes">
                      <Form.Label>Notes</Form.Label>
                      <Form.Control
                        as="textarea"
                        rows={1}
                        value={notes}
                        onChange={(event) => setNotes(event.target.value)}
                      />
                    </Form.Group>
                  </Col>
                  <Col sm={2}>
                    <Button type="submit" variant="primary" className="w-100" disabled={submitting}>
                      {submitting ? 'Saving…' : 'Save'}
                    </Button>
                  </Col>
                </Row>
              </Form>
            </Card.Body>
          </Card>

          <h2 className="h5 mb-3">Timeline</h2>
          {loadingInteractions ? (
            <div className="d-flex justify-content-center py-4">
              <Spinner animation="border" role="status">
                <span className="visually-hidden">Loading…</span>
              </Spinner>
            </div>
          ) : interactionsError ? (
            <Alert variant="danger">{interactionsError}</Alert>
          ) : interactions.length === 0 ? (
            <p className="text-body-secondary">No interactions logged yet.</p>
          ) : (
            <ListGroup>
              {interactions.map((interaction) => (
                <ListGroup.Item key={interaction.id}>
                  <div className="d-flex justify-content-between align-items-center mb-1">
                    <Badge bg="info">{interaction.type}</Badge>
                    <span className="text-body-secondary small">
                      {formatDistanceToNow(new Date(interaction.occurred_at), { addSuffix: true })}
                    </span>
                  </div>
                  {interaction.notes && <p className="mb-1">{interaction.notes}</p>}
                  <div className="text-body-secondary small">
                    Logged by {interaction.created_by_username ?? 'Unknown'}
                  </div>
                </ListGroup.Item>
              ))}
            </ListGroup>
          )}
        </>
      )}
    </Container>
  )
}
