import { formatDistanceToNow } from 'date-fns'
import { useEffect, useState } from 'react'
import Alert from 'react-bootstrap/Alert'
import Badge from 'react-bootstrap/Badge'
import Button from 'react-bootstrap/Button'
import Card from 'react-bootstrap/Card'
import Col from 'react-bootstrap/Col'
import Container from 'react-bootstrap/Container'
import Dropdown from 'react-bootstrap/Dropdown'
import Form from 'react-bootstrap/Form'
import ListGroup from 'react-bootstrap/ListGroup'
import Modal from 'react-bootstrap/Modal'
import ProgressBar from 'react-bootstrap/ProgressBar'
import Row from 'react-bootstrap/Row'
import Spinner from 'react-bootstrap/Spinner'
import Tab from 'react-bootstrap/Tab'
import Tabs from 'react-bootstrap/Tabs'
import { useParams } from 'react-router-dom'
import { get, patch, post } from '../api'
import { useAuth } from '../AuthContext.jsx'
import ArchiveButton from '../components/ArchiveButton.jsx'
import NewContactInline from '../components/NewContactInline.jsx'

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

const TASK_STATUS_LABELS = Object.fromEntries(TASK_STATUS_OPTIONS.map((option) => [option.value, option.label]))

const TASK_STATUS_BADGE_VARIANT = {
  PENDING: 'secondary',
  IN_PROGRESS: 'info',
  COMPLETED: 'success',
  NOT_APPLICABLE: 'secondary',
}

// A task that's already done just displays what was recorded -- opening it
// straight into a blank editable form (the old behaviour) reads as if
// nothing had been saved yet. PENDING/IN_PROGRESS tasks still open ready to
// work on.
const READ_ONLY_TASK_STATUSES = new Set(['COMPLETED', 'NOT_APPLICABLE'])

const MANAGEMENT_ROLES = new Set(['SALES_MANAGER', 'EXECUTIVE_MANAGER', 'SYSTEM_ADMIN'])

// Lead create/update is restricted to SALES_MANAGER/EXECUTIVE_MANAGER --
// SYSTEM_ADMIN is read-only for leads (see ArchivableOwnedResourcePermission, backend).
const MANAGER_ROLES = new Set(['SALES_MANAGER', 'EXECUTIVE_MANAGER'])

const REQUEST_TYPE_LABELS = {
  ARCHIVE_LEAD: 'Archive Lead',
  PHASE_1_SIGNOFF: 'Phase 1 Signoff',
  PHASE_2_SIGNOFF: 'Phase 2 Signoff',
  PHASE_3_SIGNOFF: 'Phase 3 Signoff',
}

const APPROVAL_STATUS_BORDER = {
  PENDING: 'border-warning',
  APPROVED: 'border-success',
  REJECTED: 'border-danger',
}

const APPROVAL_STATUS_BADGE_VARIANT = {
  PENDING: 'warning',
  APPROVED: 'success',
  REJECTED: 'danger',
}

const ACTIVITY_CATEGORY_LABELS = {
  DESTRUCTIVE: 'Destructive',
  ADMINISTRATIVE: 'Administrative',
  PHASE: 'Phase',
}

// $primary is overridden to near-black ink in this theme (see _brand.scss),
// so "blue" for administrative events has to come from `info` instead --
// `primary` would render indistinguishably from the `secondary` grey used
// for phase events.
const ACTIVITY_CATEGORY_BADGE_VARIANT = {
  DESTRUCTIVE: 'danger',
  ADMINISTRATIVE: 'info',
  PHASE: 'secondary',
}

// Colour precedence for a phase's progress bar: green only once the phase is
// actually COMPLETE (all tasks done AND sign-off approved -- 100% tasks but
// still AWAITING_APPROVAL stays amber), red beats amber whenever any task in
// the phase is overdue, amber covers active work, grey is untouched work.
function getPhaseProgressVariant(status, hasOverdueTask) {
  if (status === 'COMPLETE') {
    return 'success'
  }
  if (hasOverdueTask) {
    return 'danger'
  }
  if (status === 'IN_PROGRESS' || status === 'AWAITING_APPROVAL') {
    return 'warning'
  }
  return 'secondary'
}

// Same precedence for the overall bar, just rolled up across all three
// phases -- there's no "not started" grey state at this level.
function getOverallProgressVariant(allPhasesComplete, hasOverdueTask) {
  if (allPhasesComplete) {
    return 'success'
  }
  if (hasOverdueTask) {
    return 'danger'
  }
  return 'warning'
}

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

function KebabIcon(props) {
  return (
    <svg viewBox="0 0 16 16" width="1em" height="1em" fill="currentColor" aria-hidden="true" {...props}>
      <circle cx="8" cy="3" r="1.3" />
      <circle cx="8" cy="8" r="1.3" />
      <circle cx="8" cy="13" r="1.3" />
    </svg>
  )
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

function CategoryBadge({ variant, children }) {
  return <span className={`badge border border-${variant} text-${variant} bg-transparent fw-normal`}>{children}</span>
}

function ActivityEventRow({ entry }) {
  const variant = ACTIVITY_CATEGORY_BADGE_VARIANT[entry.event_category] ?? 'secondary'

  return (
    <ListGroup.Item className={`py-2 border-start border-3 border-${variant}`}>
      <div className="d-flex justify-content-between align-items-center mb-1">
        <CategoryBadge variant={variant}>
          {ACTIVITY_CATEGORY_LABELS[entry.event_category] ?? entry.event_category}
        </CategoryBadge>
        <span className="text-body-secondary small">
          {formatDistanceToNow(new Date(entry.occurred_at), { addSuffix: true })}
        </span>
      </div>
      <p className="mb-1">{entry.description}</p>
      <div className="text-body-secondary small">By {entry.actor_username ?? 'System'}</div>
    </ListGroup.Item>
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

function TaskDueDateGroup({ task, showHelpText }) {
  return (
    <Form.Group className="mb-3" controlId="task-due-date">
      <Form.Label>Due date</Form.Label>
      <div className={task.is_overdue ? 'text-danger' : undefined}>
        {task.due_date ? new Date(task.due_date).toLocaleDateString() : 'Not scheduled yet'}
        {task.is_overdue && ' (overdue)'}
      </div>
      {showHelpText && <Form.Text muted>Calculated automatically from the phase start date.</Form.Text>}
    </Form.Group>
  )
}

function TaskDetailReadOnly({ task, canConfirm, canEdit, saving, onConfirm, onEdit, onHide }) {
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
        <div className="mb-3">
          <div className="text-body-secondary small">Status</div>
          <Badge bg={TASK_STATUS_BADGE_VARIANT[task.status] ?? 'secondary'}>
            {TASK_STATUS_LABELS[task.status] ?? task.status}
          </Badge>
        </div>
        <TaskDueDateGroup task={task} />
        {task.committed_date && (
          <div className="mb-3">
            <div className="text-body-secondary small">Committed date</div>
            <div>{new Date(task.committed_date).toLocaleDateString()}</div>
          </div>
        )}
        <div className="mb-3">
          <div className="text-body-secondary small">Notes</div>
          <div>{task.notes || '—'}</div>
        </div>
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
        {task.confirmed_by_username && (
          <div className="text-body-secondary small">
            Confirmed by {task.confirmed_by_username}
            {task.confirmed_at && (
              <> · {formatDistanceToNow(new Date(task.confirmed_at), { addSuffix: true })}</>
            )}
          </div>
        )}
      </Modal.Body>
      <Modal.Footer>
        {canConfirm && awaitingConfirmation && (
          <Button variant="outline-success" className="me-auto" disabled={saving} onClick={onConfirm}>
            Confirm
          </Button>
        )}
        {canEdit && (
          <Button variant="outline-secondary" onClick={onEdit}>
            Edit
          </Button>
        )}
        <Button variant="secondary" onClick={onHide}>
          Close
        </Button>
      </Modal.Footer>
    </>
  )
}

function TaskDetailEditForm({ task, canConfirm, saving, error, onSave, onConfirm, onHide }) {
  // Keyed by task.id from the parent, so switching tasks remounts this with
  // fresh initial state instead of needing an effect to resync it.
  const [draftStatus, setDraftStatus] = useState(task.status)
  const [draftNotes, setDraftNotes] = useState(task.notes ?? '')
  const [draftCommittedDate, setDraftCommittedDate] = useState(task.committed_date ?? '')

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
        <TaskDueDateGroup task={task} showHelpText />
        <Form.Group className="mb-3" controlId="task-committed-date">
          <Form.Label>Committed date</Form.Label>
          <Form.Control
            type="date"
            value={draftCommittedDate}
            onChange={(event) => setDraftCommittedDate(event.target.value)}
          />
          <Form.Text muted>
            Set this when a client agrees a date on a call -- the earlier of this and the due date above is used.
          </Form.Text>
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
        <Button variant="primary" disabled={saving} onClick={() => onSave(draftStatus, draftNotes, draftCommittedDate)}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </Modal.Footer>
    </>
  )
}

function TaskDetailForm({ task, canConfirm, canEdit, saving, error, onSave, onConfirm, onHide }) {
  // Keyed by task.id from the parent (via TaskDetailModal), so switching
  // tasks remounts this with a fresh `editing` default instead of carrying
  // the previous task's mode over.
  const [editing, setEditing] = useState(!READ_ONLY_TASK_STATUSES.has(task.status))

  if (!editing) {
    return (
      <TaskDetailReadOnly
        task={task}
        canConfirm={canConfirm}
        canEdit={canEdit}
        saving={saving}
        onConfirm={onConfirm}
        onEdit={() => setEditing(true)}
        onHide={onHide}
      />
    )
  }

  return (
    <TaskDetailEditForm
      task={task}
      canConfirm={canConfirm}
      saving={saving}
      error={error}
      onSave={onSave}
      onConfirm={onConfirm}
      onHide={onHide}
    />
  )
}

function TaskDetailModal({ task, canConfirm, canEdit, saving, error, onSave, onConfirm, onHide }) {
  return (
    <Modal show={Boolean(task)} onHide={onHide} centered>
      {task && (
        <TaskDetailForm
          key={task.id}
          task={task}
          canConfirm={canConfirm}
          canEdit={canEdit}
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
  const hasOverdueTask = tasks.some((task) => task.is_overdue)

  return (
    <Card className="mb-2">
      <Card.Header className="d-flex justify-content-between align-items-center py-2">
        <span className="fw-semibold">Phase {phaseNum}</span>
        <Badge bg={PHASE_STATUS_BADGE_VARIANT[status] ?? 'secondary'}>
          {PHASE_STATUS_LABELS[status] ?? status}
        </Badge>
      </Card.Header>
      <Card.Body className="p-2">
        <div className="d-flex align-items-center gap-2 mb-2">
          <ProgressBar
            now={progress.percent}
            variant={getPhaseProgressVariant(status, hasOverdueTask)}
            className="progress-thin flex-grow-1"
          />
          <span className="small text-body-secondary flex-shrink-0">{progress.percent}%</span>
        </div>
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

function PhaseTracker({ leadId, leadAssignedTo }) {
  const { user } = useAuth()
  const canConfirm = MANAGEMENT_ROLES.has(user?.role)
  const canManageProject = MANAGER_ROLES.has(user?.role)
  const canEditTasks = canConfirm || user?.id === leadAssignedTo

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
        const data = await get(`/api/projects/?lead=${leadId}&include_archived=true`)
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
    const refreshed = await get(`/api/projects/${project.id}/?include_archived=true`)
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

  function handleSaveTask(taskStatus, notes, committedDate) {
    applyTaskUpdate({ status: taskStatus, notes, committed_date: committedDate || null })
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
      <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
        <h2 className="h5 mb-0">
          Project Phases
          {project?.is_archived && (
            <Badge bg="secondary" className="ms-2 align-middle">
              Archived
            </Badge>
          )}
        </h2>
        {project && canManageProject && (
          <Dropdown align="end">
            <Dropdown.Toggle
              variant="outline-secondary"
              size="sm"
              id="project-actions-menu"
              className="dropdown-toggle-no-caret"
              aria-label="Project actions"
            >
              <KebabIcon />
            </Dropdown.Toggle>
            <Dropdown.Menu>
              <ArchiveButton
                resource="project"
                record={project}
                onArchived={refreshProject}
                label={project.is_archived ? 'Unarchive project' : 'Archive project'}
                renderTrigger={({ onClick, label, disabled, error }) => (
                  <>
                    <Dropdown.Item onClick={onClick} disabled={disabled} className={project.is_archived ? '' : 'text-danger'}>
                      {label}
                    </Dropdown.Item>
                    {error && <div className="px-3 py-1 text-danger small">{error}</div>}
                  </>
                )}
              />
            </Dropdown.Menu>
          </Dropdown>
        )}
      </div>

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
          <div className="d-flex align-items-center gap-2 mb-3">
            <span className="small text-body-secondary flex-shrink-0">Overall progress</span>
            <ProgressBar
              now={project.overall_progress}
              variant={getOverallProgressVariant(
                PHASE_NUMBERS.every((n) => project[`phase_${n}_status`] === 'COMPLETE'),
                tasks.some((task) => task.is_overdue),
              )}
              className="progress-thin flex-grow-1"
            />
            <span className="small text-body-secondary flex-shrink-0">{project.overall_progress}%</span>
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
        canEdit={canEditTasks}
        saving={taskSaving}
        error={taskError}
        onSave={handleSaveTask}
        onConfirm={handleConfirmTask}
        onHide={closeTaskModal}
      />
    </div>
  )
}

function EditLeadForm({
  lead,
  contacts,
  salesReps,
  canEditAssignedTo,
  canEditStatus,
  saving,
  error,
  onSave,
  onHide,
  onContactCreated,
}) {
  // Keyed by lead.id from the parent, so reopening remounts this with fresh
  // initial state instead of needing an effect to resync it.
  const [name, setName] = useState(lead.name)
  const [status, setStatus] = useState(lead.status)
  const [contactId, setContactId] = useState(lead.contact ?? '')
  const [assignedTo, setAssignedTo] = useState(lead.assigned_to ?? '')

  function handleContactCreated(contact) {
    onContactCreated(contact)
    setContactId(String(contact.id))
  }

  return (
    <Form
      onSubmit={(event) => {
        event.preventDefault()
        onSave({ name, status, contactId, assignedTo })
      }}
    >
      <Modal.Header closeButton>
        <Modal.Title as="h2" className="h5 mb-0">
          Edit Lead
        </Modal.Title>
      </Modal.Header>
      <Modal.Body>
        {error && <Alert variant="danger">{error}</Alert>}
        <Form.Group className="mb-3" controlId="edit-lead-name">
          <Form.Label>Name</Form.Label>
          <Form.Control
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Wayne Enterprises — Q3 infrastructure upgrade"
            required
          />
        </Form.Group>
        <Form.Group className="mb-3" controlId="edit-lead-status">
          <Form.Label>Status</Form.Label>
          {canEditStatus ? (
            <Form.Select value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="HOT">Hot</option>
              <option value="COLD">Cold</option>
            </Form.Select>
          ) : (
            <div>
              <Badge bg={STATUS_BADGE_VARIANT[lead.status] ?? 'secondary'}>{lead.status}</Badge>
              <Form.Text className="d-block" muted>
                Only a manager can change hot/cold status.
              </Form.Text>
            </div>
          )}
        </Form.Group>
        <Form.Group className="mb-3" controlId="edit-lead-contact">
          <Form.Label>Contact</Form.Label>
          <Form.Select value={contactId} onChange={(event) => setContactId(event.target.value)}>
            <option value="">No contact</option>
            {contacts.map((contact) => (
              <option key={contact.id} value={contact.id}>
                {contact.name}
              </option>
            ))}
          </Form.Select>
          <NewContactInline companyId={lead.company} onCreated={handleContactCreated} />
        </Form.Group>
        <Form.Group controlId="edit-lead-assigned">
          <Form.Label>Assigned rep</Form.Label>
          {canEditAssignedTo ? (
            <Form.Select value={assignedTo} onChange={(event) => setAssignedTo(event.target.value)}>
              {salesReps.map((rep) => (
                <option key={rep.id} value={rep.id}>
                  {rep.username}
                </option>
              ))}
            </Form.Select>
          ) : (
            <div>{lead.assigned_to_username ?? 'Unassigned'}</div>
          )}
        </Form.Group>
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

function EditLeadModal({
  show,
  lead,
  contacts,
  salesReps,
  canEditAssignedTo,
  canEditStatus,
  onHide,
  onSaved,
  onContactCreated,
}) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  async function handleSave({ name, status, contactId, assignedTo }) {
    setSaving(true)
    setError(null)
    try {
      const payload = { name, contact: contactId ? Number(contactId) : null }
      // status is omitted entirely (not just left at its old value) when the
      // viewer can't edit it -- LeadSerializer.validate rejects the PATCH
      // outright if `status` is present at all for a non-management role,
      // even unchanged, so it must never be sent rather than merely ignored.
      if (canEditStatus) {
        payload.status = status
      }
      if (canEditAssignedTo) {
        payload.assigned_to = Number(assignedTo)
      }
      const updated = await patch(`/api/leads/${lead.id}/`, payload)
      onSaved(updated)
      onHide()
    } catch {
      setError('Failed to save lead.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal show={show} onHide={onHide} centered>
      <EditLeadForm
        key={lead.id}
        lead={lead}
        contacts={contacts}
        salesReps={salesReps}
        canEditAssignedTo={canEditAssignedTo}
        canEditStatus={canEditStatus}
        saving={saving}
        error={error}
        onSave={handleSave}
        onHide={onHide}
        onContactCreated={onContactCreated}
      />
    </Modal>
  )
}

export default function LeadDetail() {
  const { id } = useParams()
  const { user } = useAuth()

  const [lead, setLead] = useState(null)
  const [loadingLead, setLoadingLead] = useState(true)
  const [leadError, setLeadError] = useState(null)

  const [timelineEntries, setTimelineEntries] = useState([])
  const [loadingTimeline, setLoadingTimeline] = useState(true)
  const [timelineError, setTimelineError] = useState(null)

  const [contacts, setContacts] = useState([])
  const [salesReps, setSalesReps] = useState([])
  const [showEditModal, setShowEditModal] = useState(false)

  const [type, setType] = useState('CALL')
  const [outcome, setOutcome] = useState('RESPONDED')
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState(null)

  const canEdit =
    Boolean(lead) &&
    (MANAGER_ROLES.has(user?.role) || (user?.role === 'SALES_REP' && lead.assigned_to === user.id))
  const canEditAssignedTo = MANAGER_ROLES.has(user?.role)
  // Matches the backend: hot/cold is only writable by management roles (see
  // LeadSerializer.validate) -- SYSTEM_ADMIN never reaches this modal at all
  // (canEdit above excludes them), so MANAGER_ROLES covers every role that
  // actually can.
  const canEditStatus = canEditAssignedTo

  useEffect(() => {
    let cancelled = false

    async function fetchLead() {
      setLoadingLead(true)
      setLeadError(null)
      try {
        const data = await get(`/api/leads/${id}/?include_archived=true`)
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

  async function refreshLead() {
    const data = await get(`/api/leads/${id}/?include_archived=true`)
    setLead(data)
  }

  useEffect(() => {
    let cancelled = false

    async function fetchTimeline() {
      setLoadingTimeline(true)
      setTimelineError(null)
      try {
        const data = await get(`/api/leads/${id}/timeline/`)
        if (!cancelled) setTimelineEntries(data)
      } catch {
        if (!cancelled) setTimelineError('Failed to load timeline.')
      } finally {
        if (!cancelled) setLoadingTimeline(false)
      }
    }

    fetchTimeline()
    return () => {
      cancelled = true
    }
  }, [id])

  async function refreshTimeline() {
    const data = await get(`/api/leads/${id}/timeline/`)
    setTimelineEntries(data)
  }

  const leadCompanyId = lead?.company

  useEffect(() => {
    if (!leadCompanyId) {
      return
    }
    let cancelled = false

    async function fetchContacts() {
      try {
        const data = await get(`/api/contacts/?company=${leadCompanyId}`)
        if (!cancelled) setContacts(data)
      } catch {
        if (!cancelled) setContacts([])
      }
    }

    fetchContacts()
    return () => {
      cancelled = true
    }
  }, [leadCompanyId])

  useEffect(() => {
    if (!canEditAssignedTo) {
      return
    }
    let cancelled = false

    async function fetchSalesReps() {
      try {
        const data = await get('/api/users/?role=SALES_REP')
        if (!cancelled) setSalesReps(data)
      } catch {
        // Assigned-rep dropdown just falls back to "no reps available".
      }
    }

    fetchSalesReps()
    return () => {
      cancelled = true
    }
  }, [canEditAssignedTo])

  async function handleSubmit(event) {
    event.preventDefault()
    setSubmitting(true)
    setSubmitError(null)
    try {
      await post('/api/interactions/', { lead: Number(id), type, notes, ...(type !== 'NOTE' && { outcome }) })
      setNotes('')
      await Promise.all([refreshLead(), refreshTimeline()])
    } catch {
      setSubmitError('Failed to log interaction.')
    } finally {
      setSubmitting(false)
    }
  }

  // An ARCHIVE_LEAD approval request always has its own "Archive requested"/
  // "Lead archived" ActivityEvent recorded alongside it (see
  // ApprovalRequestSerializer.create/_apply_approval_side_effect on the
  // backend) -- once the approval entry itself is in the feed, those events
  // are pure restatements of the same action, so they're hidden here rather
  // than shown as a second row.
  const hasArchiveApprovalEntry = timelineEntries.some(
    (entry) => entry.entry_type === 'APPROVAL_REQUEST' && entry.request_type === 'ARCHIVE_LEAD',
  )
  const visibleTimelineEntries = timelineEntries.filter((entry) => {
    if (!hasArchiveApprovalEntry || entry.entry_type !== 'ACTIVITY_EVENT') {
      return true
    }
    return !(entry.description.startsWith('Archive requested') || entry.description.startsWith('Lead archived'))
  })

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
              <h1 className="h3 mb-1">
                {lead.name}
                {lead.is_archived && (
                  <Badge bg="secondary" className="ms-2 align-middle">
                    Archived
                  </Badge>
                )}
              </h1>
              <p className="text-body-secondary mb-0">
                {lead.company_name ?? '—'}
                {lead.contact_name && <> · {lead.contact_name}</>}
              </p>
            </div>
            <div className="d-flex align-items-center gap-2">
              <Badge bg={STATUS_BADGE_VARIANT[lead.status] ?? 'secondary'} className="fs-6">
                {lead.status}
              </Badge>
              {canEdit && (
                <Button variant="outline-secondary" size="sm" onClick={() => setShowEditModal(true)}>
                  Edit
                </Button>
              )}
              <ArchiveButton resource="lead" record={lead} onArchived={refreshLead} label="Archive lead" />
            </div>
          </div>

          <Row className="mb-4 gy-2">
            <Col sm={6} md={3}>
              <div className="text-body-secondary small">Assigned to</div>
              <div>{lead.assigned_to_username ?? 'Unassigned'}</div>
            </Col>
            <Col sm={6} md={3}>
              <div className="text-body-secondary small">Last client contact</div>
              <div>
                {lead.last_activity_at
                  ? formatDistanceToNow(new Date(lead.last_activity_at), { addSuffix: true })
                  : '—'}
              </div>
            </Col>
            <Col sm={6} md={3}>
              <div className="text-body-secondary small">Last internal activity</div>
              <div>
                {lead.last_internal_activity_at
                  ? formatDistanceToNow(new Date(lead.last_internal_activity_at), { addSuffix: true })
                  : '—'}
              </div>
            </Col>
            <Col sm={6} md={3}>
              <div className="text-body-secondary small">Interactions</div>
              <div>{lead.interaction_count ?? 0}</div>
            </Col>
          </Row>

          {canEdit && showEditModal && (
            <EditLeadModal
              show={showEditModal}
              lead={lead}
              contacts={contacts}
              salesReps={salesReps}
              canEditAssignedTo={canEditAssignedTo}
              canEditStatus={canEditStatus}
              onHide={() => setShowEditModal(false)}
              onSaved={setLead}
              onContactCreated={(contact) => setContacts((prev) => [...prev, contact])}
            />
          )}

          <Tabs defaultActiveKey="phases" id="lead-detail-tabs" className="mb-4">
            <Tab eventKey="phases" title="Phases">
              <PhaseTracker leadId={lead.id} leadAssignedTo={lead.assigned_to} />
            </Tab>
            <Tab
              eventKey="activity"
              title={
                <>
                  Activity{' '}
                  <Badge bg="secondary" pill>
                    {visibleTimelineEntries.length}
                  </Badge>
                </>
              }
            >
              <Card className="mb-4">
                <Card.Body className="py-2">
                  {submitError && <Alert variant="danger">{submitError}</Alert>}
                  <Form onSubmit={handleSubmit}>
                    <Row className="g-2 align-items-end">
                      <Col sm={3}>
                        <Form.Group controlId="interaction-type">
                          <Form.Label className="small mb-1">Type</Form.Label>
                          <Form.Select
                            size="sm"
                            value={type}
                            onChange={(event) => setType(event.target.value)}
                          >
                            {TYPE_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </Form.Select>
                        </Form.Group>
                      </Col>
                      {type !== 'NOTE' && (
                        <Col sm={3}>
                          <Form.Group controlId="interaction-outcome">
                            <Form.Label className="small mb-1">Outcome</Form.Label>
                            <Form.Select
                              size="sm"
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
                      )}
                      <Col sm={type !== 'NOTE' ? 4 : 7}>
                        <Form.Group controlId="interaction-notes">
                          <Form.Label className="small mb-1">Notes</Form.Label>
                          <Form.Control
                            as="textarea"
                            rows={1}
                            size="sm"
                            value={notes}
                            onChange={(event) => setNotes(event.target.value)}
                          />
                        </Form.Group>
                      </Col>
                      <Col sm={2}>
                        <Button type="submit" variant="primary" size="sm" className="w-100" disabled={submitting}>
                          {submitting ? 'Saving…' : 'Save'}
                        </Button>
                      </Col>
                    </Row>
                  </Form>
                </Card.Body>
              </Card>

              <h2 className="h5 mb-3">Timeline</h2>
              {loadingTimeline ? (
                <div className="d-flex justify-content-center py-4">
                  <Spinner animation="border" role="status">
                    <span className="visually-hidden">Loading…</span>
                  </Spinner>
                </div>
              ) : timelineError ? (
                <Alert variant="danger">{timelineError}</Alert>
              ) : visibleTimelineEntries.length === 0 ? (
                <p className="text-body-secondary">Nothing logged yet.</p>
              ) : (
                <ListGroup>
                  {visibleTimelineEntries.map((entry) =>
                    entry.entry_type === 'ACTIVITY_EVENT' ? (
                      <ActivityEventRow key={`activity-${entry.id}`} entry={entry} />
                    ) : entry.entry_type === 'APPROVAL_REQUEST' ? (
                      <ListGroup.Item
                        key={`approval-${entry.id}`}
                        className={`py-2 border-start border-3 ${APPROVAL_STATUS_BORDER[entry.status] ?? ''}`}
                      >
                        <div className="d-flex justify-content-between align-items-center mb-1">
                          <div className="d-flex gap-2 align-items-center">
                            <span className="fw-semibold">
                              {REQUEST_TYPE_LABELS[entry.request_type] ?? entry.request_type}
                            </span>
                            <CategoryBadge variant={APPROVAL_STATUS_BADGE_VARIANT[entry.status] ?? 'secondary'}>
                              {entry.status}
                            </CategoryBadge>
                          </div>
                          <span className="text-body-secondary small">
                            {formatDistanceToNow(new Date(entry.created_at), { addSuffix: true })}
                          </span>
                        </div>
                        {entry.reason && <p className="mb-1">{entry.reason}</p>}
                        {entry.status === 'REJECTED' && entry.decision_note && (
                          <p className="mb-1 fst-italic">{entry.decision_note}</p>
                        )}
                        <div className="text-body-secondary small">
                          Requested by {entry.requested_by_username ?? 'Unknown'}
                        </div>
                      </ListGroup.Item>
                    ) : (
                      <ListGroup.Item key={`interaction-${entry.id}`} className="py-2 border-start border-3 border-secondary-subtle">
                        <div className="d-flex justify-content-between align-items-center mb-1">
                          <div className="d-flex gap-2">
                            <Badge bg="info">{entry.type}</Badge>
                            {entry.outcome && (
                              <Badge bg={OUTCOME_BADGE_VARIANT[entry.outcome] ?? 'secondary'}>{entry.outcome}</Badge>
                            )}
                          </div>
                          <span className="text-body-secondary small">
                            {formatDistanceToNow(new Date(entry.occurred_at), { addSuffix: true })}
                          </span>
                        </div>
                        {entry.notes && <p className="mb-1">{entry.notes}</p>}
                        <div className="text-body-secondary small">
                          Logged by {entry.created_by_username ?? 'Unknown'}
                        </div>
                      </ListGroup.Item>
                    ),
                  )}
                </ListGroup>
              )}
            </Tab>
          </Tabs>
        </>
      )}
    </Container>
  )
}
