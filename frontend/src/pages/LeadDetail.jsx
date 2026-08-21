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
import ProgressBar from 'react-bootstrap/ProgressBar'
import Row from 'react-bootstrap/Row'
import Spinner from 'react-bootstrap/Spinner'
import { useParams } from 'react-router-dom'
import { get, patch, post } from '../api'

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

const OUTCOME_OPTIONS = [
  { value: 'RESPONDED', label: 'Responded' },
  { value: 'NO_ANSWER', label: 'No Answer' },
  { value: 'MISSED_CALL', label: 'Missed Call' },
  { value: 'LEFT_MESSAGE', label: 'Left Message' },
  { value: 'BOUNCED', label: 'Bounced' },
]

const OUTCOME_BADGE_VARIANT = {
  RESPONDED: 'success',
  NO_ANSWER: 'secondary',
  MISSED_CALL: 'secondary',
  LEFT_MESSAGE: 'info',
  BOUNCED: 'danger',
}

const PHASE_NUMBERS = [1, 2, 3]

const PHASE_STATUS_BADGE_VARIANT = {
  NOT_STARTED: 'secondary',
  IN_PROGRESS: 'info',
  AWAITING_APPROVAL: 'warning',
  COMPLETE: 'success',
}

const PHASE_STATUS_LABELS = {
  NOT_STARTED: 'Not Started',
  IN_PROGRESS: 'In Progress',
  AWAITING_APPROVAL: 'Awaiting Approval',
  COMPLETE: 'Complete',
}

function RequirementItem({ requirement, onUpload, uploading }) {
  if (requirement.is_complete) {
    const filename = requirement.document ? requirement.document.split('/').pop() : null
    return (
      <ListGroup.Item className="d-flex justify-content-between align-items-start gap-2">
        <div>
          <div className="text-decoration-line-through text-body-secondary">{requirement.label}</div>
          {filename && (
            <div className="small text-body-secondary">
              {filename} · {requirement.completed_by_username ?? 'Unknown'}
              {requirement.completed_at && (
                <> · {formatDistanceToNow(new Date(requirement.completed_at), { addSuffix: true })}</>
              )}
            </div>
          )}
        </div>
        <Badge bg="success">Done</Badge>
      </ListGroup.Item>
    )
  }

  return (
    <ListGroup.Item>
      <div className="d-flex justify-content-between align-items-center gap-2 mb-2">
        <span>{requirement.label}</span>
        <Badge bg="secondary">Pending</Badge>
      </div>
      <Form.Control
        type="file"
        size="sm"
        disabled={uploading}
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) onUpload(requirement.id, file)
        }}
      />
    </ListGroup.Item>
  )
}

function PhaseCard({ phaseNum, status, progress, requirements, uploadingId, onUpload, pendingSignoff, onRequestSignoff }) {
  const allComplete = progress.total > 0 && progress.completed === progress.total
  const canRequestSignoff = allComplete && status !== 'COMPLETE'

  return (
    <Card className="h-100">
      <Card.Header className="d-flex justify-content-between align-items-center">
        <span>Phase {phaseNum}</span>
        <Badge bg={PHASE_STATUS_BADGE_VARIANT[status] ?? 'secondary'}>
          {PHASE_STATUS_LABELS[status] ?? status}
        </Badge>
      </Card.Header>
      <Card.Body className="d-flex flex-column">
        <ProgressBar now={progress.percent} label={`${progress.percent}%`} className="mb-3" />
        <ListGroup variant="flush" className="mb-3">
          {requirements.map((requirement) => (
            <RequirementItem
              key={requirement.id}
              requirement={requirement}
              onUpload={onUpload}
              uploading={uploadingId === requirement.id}
            />
          ))}
        </ListGroup>
        {canRequestSignoff && (
          <Button
            size="sm"
            variant="outline-primary"
            className="mt-auto"
            disabled={pendingSignoff}
            onClick={() => onRequestSignoff(phaseNum)}
          >
            {pendingSignoff ? 'Sign-off requested' : 'Request sign-off'}
          </Button>
        )}
      </Card.Body>
    </Card>
  )
}

function PhaseTracker({ companyId }) {
  const [project, setProject] = useState(null)
  const [loadingProject, setLoadingProject] = useState(true)
  const [projectError, setProjectError] = useState(null)

  const [requirements, setRequirements] = useState([])

  const [uploadingId, setUploadingId] = useState(null)
  const [uploadError, setUploadError] = useState(null)
  const [signoffError, setSignoffError] = useState(null)

  useEffect(() => {
    let cancelled = false

    async function fetchProject() {
      setLoadingProject(true)
      setProjectError(null)
      try {
        const data = await get(`/api/projects/?company=${companyId}`)
        if (!cancelled) setProject(data[0] ?? null)
      } catch {
        if (!cancelled) setProjectError('Failed to load project.')
      } finally {
        if (!cancelled) setLoadingProject(false)
      }
    }

    fetchProject()
    return () => {
      cancelled = true
    }
  }, [companyId])

  useEffect(() => {
    let cancelled = false

    async function fetchRequirements() {
      if (!project) {
        setRequirements([])
        return
      }
      try {
        const data = await get(`/api/requirements/?project=${project.id}`)
        if (!cancelled) setRequirements(data)
      } catch {
        if (!cancelled) setRequirements([])
      }
    }

    fetchRequirements()
    return () => {
      cancelled = true
    }
  }, [project])

  async function handleUpload(requirementId, file) {
    setUploadingId(requirementId)
    setUploadError(null)
    try {
      const formData = new FormData()
      formData.append('document', file)
      const updated = await patch(`/api/requirements/${requirementId}/`, formData)
      setRequirements((prev) => prev.map((r) => (r.id === requirementId ? updated : r)))
      const refreshedProject = await get(`/api/projects/${project.id}/`)
      setProject(refreshedProject)
    } catch {
      setUploadError('Failed to upload document.')
    } finally {
      setUploadingId(null)
    }
  }

  async function handleRequestSignoff(phaseNum) {
    setSignoffError(null)
    try {
      await post('/api/approvals/', {
        request_type: `PHASE_${phaseNum}_SIGNOFF`,
        project: project.id,
      })
      const refreshedProject = await get(`/api/projects/${project.id}/`)
      setProject(refreshedProject)
    } catch {
      setSignoffError(`Failed to request phase ${phaseNum} sign-off.`)
    }
  }

  return (
    <div className="mb-4">
      <h2 className="h5 mb-3">Project Phases</h2>

      {loadingProject ? (
        <div className="d-flex justify-content-center py-4">
          <Spinner animation="border" role="status">
            <span className="visually-hidden">Loading…</span>
          </Spinner>
        </div>
      ) : projectError ? (
        <Alert variant="danger">{projectError}</Alert>
      ) : !project ? (
        <Row className="g-3">
          {PHASE_NUMBERS.map((phaseNum) => (
            <Col md={4} key={phaseNum}>
              <Card className="h-100 opacity-50">
                <Card.Header>Phase {phaseNum}</Card.Header>
                <Card.Body>
                  <p className="text-body-secondary mb-0">Phases begin once the deal is Closed-Won.</p>
                </Card.Body>
              </Card>
            </Col>
          ))}
        </Row>
      ) : (
        <>
          {signoffError && <Alert variant="danger">{signoffError}</Alert>}
          {uploadError && <Alert variant="danger">{uploadError}</Alert>}
          <div className="mb-3">
            <div className="d-flex justify-content-between small text-body-secondary mb-1">
              <span>Overall progress</span>
              <span>{project.overall_progress}%</span>
            </div>
            <ProgressBar now={project.overall_progress} />
          </div>
          <Row className="g-3">
            {PHASE_NUMBERS.map((phaseNum) => (
              <Col md={4} key={phaseNum}>
                <PhaseCard
                  phaseNum={phaseNum}
                  status={project[`phase_${phaseNum}_status`]}
                  progress={project.phase_progress[phaseNum]}
                  requirements={requirements.filter((r) => r.phase === phaseNum)}
                  uploadingId={uploadingId}
                  onUpload={handleUpload}
                  pendingSignoff={project.pending_approval_requests?.includes(`PHASE_${phaseNum}_SIGNOFF`)}
                  onRequestSignoff={handleRequestSignoff}
                />
              </Col>
            ))}
          </Row>
        </>
      )}
    </div>
  )
}

export default function LeadDetail() {
  const { id } = useParams()

  const [lead, setLead] = useState(null)
  const [loadingLead, setLoadingLead] = useState(true)
  const [leadError, setLeadError] = useState(null)

  const [interactions, setInteractions] = useState([])
  const [loadingInteractions, setLoadingInteractions] = useState(true)
  const [interactionsError, setInteractionsError] = useState(null)

  const [type, setType] = useState('CALL')
  const [outcome, setOutcome] = useState('RESPONDED')
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
      await post('/api/interactions/', { lead: Number(id), type, outcome, notes })
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
    <Container style={{ maxWidth: '56rem' }}>
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

          <PhaseTracker companyId={lead.company} />

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
                  <Col sm={3}>
                    <Form.Group controlId="interaction-outcome">
                      <Form.Label>Outcome</Form.Label>
                      <Form.Select
                        value={outcome}
                        onChange={(event) => setOutcome(event.target.value)}
                        required
                      >
                        {OUTCOME_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </Form.Select>
                    </Form.Group>
                  </Col>
                  <Col sm={4}>
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
                    <div className="d-flex gap-2">
                      <Badge bg="info">{interaction.type}</Badge>
                      <Badge bg={OUTCOME_BADGE_VARIANT[interaction.outcome] ?? 'secondary'}>
                        {interaction.outcome}
                      </Badge>
                    </div>
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
