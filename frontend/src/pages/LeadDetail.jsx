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
import Modal from 'react-bootstrap/Modal'
import ProgressBar from 'react-bootstrap/ProgressBar'
import Row from 'react-bootstrap/Row'
import Spinner from 'react-bootstrap/Spinner'
import { useParams } from 'react-router-dom'
import { get, patch, post } from '../api'
import { useAuth } from '../AuthContext.jsx'

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

const TASK_STATUS_OPTIONS = [
  { value: 'PENDING', label: 'Pending' },
  { value: 'IN_PROGRESS', label: 'In Progress' },
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'NOT_APPLICABLE', label: 'Not Applicable' },
]

const MANAGEMENT_ROLES = new Set(['SALES_MANAGER', 'EXECUTIVE_MANAGER', 'SYSTEM_ADMIN'])

// "confirmed" / "awaiting" / "pending" / "not_applicable" -- derived client
// side from status + confirmation_authority + confirmed_by, mirroring the
// server's PhaseRequirement.is_confirmed_complete.
function getTaskState(task) {
  if (task.status === 'NOT_APPLICABLE') {
    return 'not_applicable'
  }
  if (task.status === 'COMPLETED') {
    const confirmed = task.confirmation_authority === 'REP' || Boolean(task.confirmed_by)
    return confirmed ? 'confirmed' : 'awaiting'
  }
  return 'pending'
}

function CheckIcon(props) {
  return (
    <svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" aria-hidden="true" {...props}>
      <path d="M4 8.3 6.8 11l5.2-6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ClockIcon(props) {
  return (
    <svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" aria-hidden="true" {...props}>
      <circle cx="8" cy="8" r="6.3" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 4.8V8l2.3 1.3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function CircleIcon(props) {
  return (
    <svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" aria-hidden="true" {...props}>
      <circle cx="8" cy="8" r="6.3" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

function DashIcon(props) {
  return (
    <svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" aria-hidden="true" {...props}>
      <path d="M4 8h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function TaskStatusIcon({ state }) {
  if (state === 'confirmed') {
    return (
      <span className="text-success" title="Confirmed">
        <CheckIcon />
      </span>
    )
  }
  if (state === 'awaiting') {
    return (
      <span className="text-warning" title="Awaiting confirmation">
        <ClockIcon />
      </span>
    )
  }
  if (state === 'not_applicable') {
    return (
      <span className="text-body-secondary" title="Not applicable">
        <DashIcon />
      </span>
    )
  }
  return (
    <span className="text-body-secondary" title="Pending">
      <CircleIcon />
    </span>
  )
}

function TaskRow({ task, onOpen }) {
  const state = getTaskState(task)
  return (
    <ListGroup.Item action onClick={() => onOpen(task)} className="d-flex align-items-center gap-2">
      <TaskStatusIcon state={state} />
      <span className={`flex-grow-1 ${state === 'not_applicable' ? 'text-decoration-line-through text-body-secondary' : ''}`}>
        {task.label}
      </span>
      <Badge bg={task.confirmation_authority === 'MANAGER' ? 'info' : 'secondary'}>
        {task.confirmation_authority === 'MANAGER' ? 'Manager' : 'Rep'}
      </Badge>
    </ListGroup.Item>
  )
}

function TaskDetailForm({ task, canConfirm, saving, error, onSave, onConfirm, onHide }) {
  // Keyed by task.id from the parent, so switching tasks remounts this with
  // fresh initial state instead of needing an effect to resync it.
  const [draftStatus, setDraftStatus] = useState(task.status)
  const [draftNotes, setDraftNotes] = useState(task.notes ?? '')

  const awaitingConfirmation =
    task.status === 'COMPLETED' && task.confirmation_authority === 'MANAGER' && !task.confirmed_by

  return (
    <>
      <Modal.Header closeButton>
        <Modal.Title as="h2" className="h5 mb-0">
          {task.label}
        </Modal.Title>
      </Modal.Header>
      <Modal.Body>
        {task.description && <p className="text-body-secondary">{task.description}</p>}
        {error && <Alert variant="danger">{error}</Alert>}
        <Form.Group className="mb-3" controlId="task-status">
          <Form.Label>Status</Form.Label>
          <Form.Select value={draftStatus} onChange={(event) => setDraftStatus(event.target.value)}>
            {TASK_STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Form.Select>
        </Form.Group>
        <Form.Group className="mb-3" controlId="task-notes">
          <Form.Label>Notes</Form.Label>
          <Form.Control
            as="textarea"
            rows={3}
            value={draftNotes}
            onChange={(event) => setDraftNotes(event.target.value)}
          />
        </Form.Group>
        <div className="text-body-secondary small">
          {task.updated_by_username ? (
            <>
              Last updated by {task.updated_by_username}
              {task.updated_at && (
                <> · {formatDistanceToNow(new Date(task.updated_at), { addSuffix: true })}</>
              )}
            </>
          ) : (
            'Not yet updated.'
          )}
        </div>
      </Modal.Body>
      <Modal.Footer>
        {canConfirm && awaitingConfirmation && (
          <Button variant="outline-success" className="me-auto" disabled={saving} onClick={onConfirm}>
            Confirm
          </Button>
        )}
        <Button variant="secondary" onClick={onHide} disabled={saving}>
          Cancel
        </Button>
        <Button variant="primary" disabled={saving} onClick={() => onSave(draftStatus, draftNotes)}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </Modal.Footer>
    </>
  )
}

function TaskDetailModal({ task, canConfirm, saving, error, onSave, onConfirm, onHide }) {
  return (
    <Modal show={Boolean(task)} onHide={onHide} centered>
      {task && (
        <TaskDetailForm
          key={task.id}
          task={task}
          canConfirm={canConfirm}
          saving={saving}
          error={error}
          onSave={onSave}
          onConfirm={onConfirm}
          onHide={onHide}
        />
      )}
    </Modal>
  )
}

function PhaseCard({ phaseNum, status, progress, tasks, onOpenTask, pendingSignoff, onRequestSignoff }) {
  const allComplete = progress.total > 0 && progress.completed === progress.total
  const canRequestSignoff = allComplete && status !== 'COMPLETE'

  return (
    <Card className="mb-3">
      <Card.Header className="d-flex justify-content-between align-items-center">
        <span className="fw-semibold">Phase {phaseNum}</span>
        <Badge bg={PHASE_STATUS_BADGE_VARIANT[status] ?? 'secondary'}>
          {PHASE_STATUS_LABELS[status] ?? status}
        </Badge>
      </Card.Header>
      <Card.Body>
        <ProgressBar now={progress.percent} label={`${progress.percent}%`} className="mb-3" />
        <ListGroup variant="flush" className="mb-3">
          {tasks.map((task) => (
            <TaskRow key={task.id} task={task} onOpen={onOpenTask} />
          ))}
        </ListGroup>
        {canRequestSignoff && (
          <Button
            size="sm"
            variant="outline-primary"
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

function PhaseTracker({ leadId }) {
  const { user } = useAuth()
  const canConfirm = MANAGEMENT_ROLES.has(user?.role)

  const [project, setProject] = useState(null)
  const [loadingProject, setLoadingProject] = useState(true)
  const [projectError, setProjectError] = useState(null)

  const [tasks, setTasks] = useState([])

  const [signoffError, setSignoffError] = useState(null)

  const [activeTask, setActiveTask] = useState(null)
  const [taskSaving, setTaskSaving] = useState(false)
  const [taskError, setTaskError] = useState(null)

  useEffect(() => {
    let cancelled = false

    async function fetchProject() {
      setLoadingProject(true)
      setProjectError(null)
      try {
        const data = await get(`/api/projects/?lead=${leadId}`)
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
  }, [leadId])

  useEffect(() => {
    let cancelled = false

    async function fetchTasks() {
      if (!project) {
        setTasks([])
        return
      }
      try {
        const data = await get(`/api/requirements/?project=${project.id}`)
        if (!cancelled) setTasks(data)
      } catch {
        if (!cancelled) setTasks([])
      }
    }

    fetchTasks()
    return () => {
      cancelled = true
    }
  }, [project])

  async function refreshProject() {
    const refreshed = await get(`/api/projects/${project.id}/`)
    setProject(refreshed)
  }

  async function applyTaskUpdate(payload) {
    if (!activeTask) return
    setTaskSaving(true)
    setTaskError(null)
    try {
      const updated = await patch(`/api/requirements/${activeTask.id}/`, payload)
      setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))
      await refreshProject()
      setActiveTask(null)
    } catch {
      setTaskError('Failed to save the task.')
    } finally {
      setTaskSaving(false)
    }
  }

  function handleSaveTask(taskStatus, notes) {
    applyTaskUpdate({ status: taskStatus, notes })
  }

  function handleConfirmTask() {
    applyTaskUpdate({ status: 'COMPLETED' })
  }

  function openTask(task) {
    setTaskError(null)
    setActiveTask(task)
  }

  function closeTaskModal() {
    setActiveTask(null)
  }

  async function handleRequestSignoff(phaseNum) {
    setSignoffError(null)
    try {
      await post('/api/approvals/', {
        request_type: `PHASE_${phaseNum}_SIGNOFF`,
        project: project.id,
      })
      await refreshProject()
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
        <div className="d-flex flex-column gap-3">
          {PHASE_NUMBERS.map((phaseNum) => (
            <Card key={phaseNum} className="opacity-50">
              <Card.Header>Phase {phaseNum}</Card.Header>
              <Card.Body>
                <p className="text-body-secondary mb-0">Phases begin once the deal is Closed-Won.</p>
              </Card.Body>
            </Card>
          ))}
        </div>
      ) : (
        <>
          {signoffError && <Alert variant="danger">{signoffError}</Alert>}
          <div className="mb-3">
            <div className="d-flex justify-content-between small text-body-secondary mb-1">
              <span>Overall progress</span>
              <span>{project.overall_progress}%</span>
            </div>
            <ProgressBar now={project.overall_progress} />
          </div>
          {PHASE_NUMBERS.map((phaseNum) => (
            <PhaseCard
              key={phaseNum}
              phaseNum={phaseNum}
              status={project[`phase_${phaseNum}_status`]}
              progress={project.phase_progress[phaseNum]}
              tasks={tasks.filter((t) => t.phase === phaseNum)}
              onOpenTask={openTask}
              pendingSignoff={project.pending_approval_requests?.includes(`PHASE_${phaseNum}_SIGNOFF`)}
              onRequestSignoff={handleRequestSignoff}
            />
          ))}
        </>
      )}

      <TaskDetailModal
        task={activeTask}
        canConfirm={canConfirm}
        saving={taskSaving}
        error={taskError}
        onSave={handleSaveTask}
        onConfirm={handleConfirmTask}
        onHide={closeTaskModal}
      />
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

          <PhaseTracker leadId={lead.id} />

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
