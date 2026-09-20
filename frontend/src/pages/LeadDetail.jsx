import { formatDistanceToNow } from 'date-fns'
import { Pencil } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
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
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { del, errorMessage, get, patch, post } from '../api'
import { useAuth } from '../AuthContext.jsx'
import ArchiveButton from '../components/ArchiveButton.jsx'
import Avatar, { PersonCell, ROLE_LABELS } from '../components/Avatar.jsx'
import ContactDetails from '../components/ContactDetails.jsx'
import FormFieldsEditor from '../components/FormFieldsEditor.jsx'
import NewContactInline from '../components/NewContactInline.jsx'
import { usePageMeta } from '../components/PageChrome.jsx'
import StatusPill, { LEAD_STATUS_TONE, PHASE_STATUS_TONE } from '../components/StatusPill.jsx'
import { formFieldsPayload } from '../formFields.js'

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

const PHASE_NUMBERS = [1, 2, 3, 4]

const EXECUTION_STATUS_OPTIONS = [
  { value: 'STARTED', label: 'Started' },
  { value: 'BUILDING', label: 'Building' },
  { value: 'TESTING', label: 'Testing' },
  { value: 'REVIEW', label: 'Review' },
  { value: 'COMPLETED', label: 'Completed' },
]

const EXECUTION_STATUS_LABELS = Object.fromEntries(EXECUTION_STATUS_OPTIONS.map((option) => [option.value, option.label]))

// current_phase on the model isn't kept in sync as phases progress (see
// Project model) -- the real "which phase are we in" answer is the first
// phase whose status isn't COMPLETE yet, falling back to the last phase once
// every phase (including maintenance) is done.
function getCurrentPhaseNumber(project) {
  return PHASE_NUMBERS.find((phaseNum) => project[`phase_${phaseNum}_status`] !== 'COMPLETE') ?? PHASE_NUMBERS.at(-1)
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

// Task statuses reuse the phase tones -- the same four states, read at a
// different scale.
const TASK_STATUS_TONE = {
  PENDING: 'grey',
  IN_PROGRESS: 'blue',
  COMPLETED: 'green',
  NOT_APPLICABLE: 'grey',
}

// Mirrors PhaseRequirementSerializer.COMPLETION_ROLE_BY_PHASE on the backend
// -- who is allowed to move a task INTO Completed depends only on its phase,
// never on confirmation_authority or a general "can edit this task" right.
function completionResponsibilityMessage(task) {
  if (task.phase === 1 || task.phase === 4) {
    return 'Only the sales rep assigned to this lead can mark this task complete.'
  }
  return 'Only the project manager assigned to this project can mark this task complete.'
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
  LEAD_STATUS_CHANGE: 'Lead Status Change',
  PHASE_1_SIGNOFF: 'Phase 1 Signoff',
  PHASE_2_SIGNOFF: 'Phase 2 Signoff',
  PHASE_4_SIGNOFF: 'Phase 4 Signoff',
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
  // Who the task belongs to: the assigned rep on phases 1 and 4, the
  // assigned PM on 2 and 3 (PhaseRequirement.responsible_user). A phase 2
  // or 3 task on a project with no PM yet has nobody, which the placeholder
  // says rather than leaving a gap in the row.
  const responsible = task.responsible_username
  const responsibleLabel = responsible
    ? `${responsible}${ROLE_LABELS[task.responsible_role] ? ` · ${ROLE_LABELS[task.responsible_role]}` : ''}`
    : 'Nobody assigned yet'

  return (
    <ListGroup.Item action onClick={() => onOpen(task)} className="d-flex align-items-center gap-2">
      <TaskStatusIcon state={state} />
      <span className={`flex-grow-1 ${state === 'not_applicable' ? 'text-decoration-line-through text-body-secondary' : ''}`}>
        {task.label}
      </span>
      {responsible ? (
        <Avatar name={responsible} role={task.responsible_role} size="sm" title={responsibleLabel} />
      ) : (
        <span className="avatar avatar--sm avatar--vacant" aria-hidden="true" title={responsibleLabel}>
          ?
        </span>
      )}
      {/* The avatar itself is aria-hidden (it has no name beside it here),
          so the row carries the same information as text for a screen
          reader -- it just isn't drawn. */}
      <span className="visually-hidden">{responsibleLabel}</span>
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

// Google Forms links need ?embedded=true to render inside an iframe instead
// of refusing (Google's own embedding requirement) -- everything else is
// passed straight through, iframe-or-not being something we can't reliably
// detect client-side anyway (X-Frame-Options isn't inspectable from here).
function normalizeEmbedUrl(url) {
  try {
    const parsed = new URL(url)
    if (parsed.hostname === 'docs.google.com' && parsed.pathname.includes('/forms/')) {
      parsed.searchParams.set('embedded', 'true')
      return parsed.toString()
    }
    return url
  } catch {
    return url
  }
}

function AttachmentPreviewModal({ attachment, onHide }) {
  if (!attachment) {
    return null
  }

  const downloadUrl = `/api/attachments/${attachment.id}/download/`
  let body
  if (attachment.kind === 'LINK') {
    body = (
      <>
        <iframe
          title={attachment.title}
          src={normalizeEmbedUrl(attachment.url)}
          style={{ width: '100%', height: '70vh', border: 0 }}
        />
        <div className="mt-2">
          {/* Some sites refuse to render in an iframe (X-Frame-Options) with
              no way for us to detect that up front -- always offer this. */}
          <a href={attachment.url} target="_blank" rel="noreferrer">
            Open in new tab
          </a>
        </div>
      </>
    )
  } else if (attachment.content_type === 'application/pdf') {
    body = <iframe title={attachment.title} src={downloadUrl} style={{ width: '100%', height: '70vh', border: 0 }} />
  } else if (attachment.content_type?.startsWith('image/')) {
    body = <img src={downloadUrl} alt={attachment.title} style={{ maxWidth: '100%' }} />
  } else {
    body = (
      <a href={downloadUrl} target="_blank" rel="noreferrer">
        Download {attachment.original_filename || attachment.title}
      </a>
    )
  }

  return (
    <Modal show onHide={onHide} centered size="lg">
      <Modal.Header closeButton>
        <Modal.Title as="h2" className="h5 mb-0">
          {attachment.title}
        </Modal.Title>
      </Modal.Header>
      <Modal.Body>{body}</Modal.Body>
    </Modal>
  )
}

function TaskAttachmentsSection({ requirementId }) {
  const { user } = useAuth()
  const [attachments, setAttachments] = useState([])
  const [loading, setLoading] = useState(true)
  const [previewAttachment, setPreviewAttachment] = useState(null)

  const [addMode, setAddMode] = useState(null)
  const [file, setFile] = useState(null)
  const [linkUrl, setLinkUrl] = useState('')
  const [linkTitle, setLinkTitle] = useState('')
  const [addSaving, setAddSaving] = useState(false)
  const [addError, setAddError] = useState(null)

  const [deletingId, setDeletingId] = useState(null)
  const [deleteError, setDeleteError] = useState(null)

  useEffect(() => {
    let cancelled = false

    async function fetchAttachments() {
      setLoading(true)
      try {
        const data = await get(`/api/attachments/?requirement=${requirementId}`)
        if (!cancelled) setAttachments(data)
      } catch {
        if (!cancelled) setAttachments([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchAttachments()
    return () => {
      cancelled = true
    }
  }, [requirementId])

  function canDelete(attachment) {
    return MANAGEMENT_ROLES.has(user?.role) || attachment.uploaded_by === user?.id
  }

  async function handleUploadFile(event) {
    event.preventDefault()
    if (!file) return
    setAddSaving(true)
    setAddError(null)
    try {
      const formData = new FormData()
      formData.append('requirement', requirementId)
      formData.append('kind', 'FILE')
      formData.append('file', file)
      const created = await post('/api/attachments/', formData)
      setAttachments((prev) => [created, ...prev])
      setAddMode(null)
      setFile(null)
    } catch (err) {
      setAddError(errorMessage(err, 'Failed to upload the file -- PDF, images and .docx only, up to 15 MB.'))
    } finally {
      setAddSaving(false)
    }
  }

  async function handleAddLink(event) {
    event.preventDefault()
    setAddSaving(true)
    setAddError(null)
    try {
      const created = await post('/api/attachments/', {
        requirement: requirementId,
        kind: 'LINK',
        url: linkUrl,
        title: linkTitle,
      })
      setAttachments((prev) => [created, ...prev])
      setAddMode(null)
      setLinkUrl('')
      setLinkTitle('')
    } catch (err) {
      setAddError(errorMessage(err, 'Failed to add the link.'))
    } finally {
      setAddSaving(false)
    }
  }

  async function handleDelete(attachment) {
    setDeletingId(attachment.id)
    setDeleteError(null)
    try {
      await del(`/api/attachments/${attachment.id}/`)
      setAttachments((prev) => prev.filter((a) => a.id !== attachment.id))
    } catch (err) {
      setDeleteError(errorMessage(err, 'Failed to delete the attachment.'))
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="mt-3 pt-3 border-top">
      <div className="d-flex justify-content-between align-items-center mb-2">
        <div className="text-body-secondary small fw-semibold">Attachments</div>
        <div className="d-flex gap-1">
          <Button size="sm" variant="outline-secondary" onClick={() => setAddMode(addMode === 'file' ? null : 'file')}>
            + File
          </Button>
          <Button size="sm" variant="outline-secondary" onClick={() => setAddMode(addMode === 'link' ? null : 'link')}>
            + Link
          </Button>
        </div>
      </div>

      {deleteError && <Alert variant="danger" className="py-1 small">{deleteError}</Alert>}

      {loading ? (
        <Spinner animation="border" size="sm" />
      ) : attachments.length === 0 ? (
        <p className="text-body-secondary small mb-2">No attachments yet.</p>
      ) : (
        <ListGroup variant="flush" className="mb-2">
          {attachments.map((attachment) => (
            <ListGroup.Item key={attachment.id} className="d-flex justify-content-between align-items-center py-1 px-0">
              <Button variant="link" className="p-0 text-start" onClick={() => setPreviewAttachment(attachment)}>
                {attachment.title || attachment.original_filename || attachment.url}
              </Button>
              {canDelete(attachment) && (
                <Button
                  size="sm"
                  variant="link"
                  className="text-danger p-0"
                  disabled={deletingId === attachment.id}
                  onClick={() => handleDelete(attachment)}
                >
                  Delete
                </Button>
              )}
            </ListGroup.Item>
          ))}
        </ListGroup>
      )}

      {addMode === 'file' && (
        <Form onSubmit={handleUploadFile} className="d-flex gap-2 align-items-center mb-2">
          <Form.Control
            size="sm"
            type="file"
            aria-label="Attachment file"
            onChange={(event) => setFile(event.target.files[0] ?? null)}
            required
          />
          <Button size="sm" type="submit" disabled={addSaving || !file}>
            {addSaving ? 'Uploading…' : 'Upload'}
          </Button>
        </Form>
      )}
      {addMode === 'link' && (
        <Form onSubmit={handleAddLink} className="d-flex flex-column gap-2 mb-2">
          <Form.Control
            size="sm"
            placeholder="Title"
            value={linkTitle}
            onChange={(event) => setLinkTitle(event.target.value)}
            required
          />
          <Form.Control
            size="sm"
            type="url"
            placeholder="https://…"
            value={linkUrl}
            onChange={(event) => setLinkUrl(event.target.value)}
            required
          />
          <Button size="sm" type="submit" disabled={addSaving} className="align-self-start">
            {addSaving ? 'Adding…' : 'Add link'}
          </Button>
        </Form>
      )}
      {addError && <Alert variant="danger" className="py-1 small">{addError}</Alert>}

      <AttachmentPreviewModal attachment={previewAttachment} onHide={() => setPreviewAttachment(null)} />
    </div>
  )
}

// Builds { fieldId: value } from the task's saved form_responses, defaulting
// any field with no saved response yet to '' -- the shape both the read-only
// summary and the editor key off of.
function buildInitialAnswers(task) {
  const responsesByField = Object.fromEntries((task.form_responses ?? []).map((r) => [r.field, r.value]))
  return Object.fromEntries((task.form_fields ?? []).map((f) => [f.id, responsesByField[f.id] ?? '']))
}

// Drives both the task row's indicator and the form section's own summary --
// a required field counts as outstanding only when it has no saved
// (non-blank) response yet, matching the backend's own completion gate
// (PhaseRequirementSerializer.validate).
function hasOutstandingRequiredFields(task) {
  const required = (task.form_fields ?? []).filter((f) => f.required)
  if (required.length === 0) return false
  const answeredIds = new Set((task.form_responses ?? []).filter((r) => r.value).map((r) => r.field))
  return required.some((f) => !answeredIds.has(f.id))
}

function formatAnswerValue(field, value) {
  if (!value) return '—'
  if (field.field_type === 'CHECKBOX') return value === 'true' ? 'Yes' : 'No'
  if (field.field_type === 'DATE') return new Date(value).toLocaleDateString()
  return value
}

function TaskFormFieldsReadOnly({ task }) {
  const fields = task.form_fields ?? []
  if (fields.length === 0) return null
  const responsesByField = Object.fromEntries((task.form_responses ?? []).map((r) => [r.field, r.value]))
  return (
    <div className="mb-3">
      <div className="text-body-secondary small fw-semibold mb-1">Form answers</div>
      {fields.map((field) => (
        <div key={field.id} className="mb-2">
          <div className="text-body-secondary small">{field.label}</div>
          <div>{formatAnswerValue(field, responsesByField[field.id])}</div>
        </div>
      ))}
    </div>
  )
}

function TaskFormFieldsEditor({ fields, answers, onChange }) {
  if (fields.length === 0) return null
  return (
    <div className="mb-3">
      <div className="text-body-secondary small fw-semibold mb-2">Form</div>
      {fields.map((field) => (
        <Form.Group className="mb-3" key={field.id} controlId={`task-form-field-${field.id}`}>
          {field.field_type === 'CHECKBOX' ? (
            <Form.Check
              type="checkbox"
              label={field.required ? `${field.label} *` : field.label}
              checked={answers[field.id] === 'true'}
              onChange={(event) => onChange(field.id, event.target.checked ? 'true' : 'false')}
            />
          ) : (
            <>
              <Form.Label>
                {field.label}
                {field.required && <span className="text-danger"> *</span>}
              </Form.Label>
              {field.field_type === 'TEXTAREA' ? (
                <Form.Control
                  as="textarea"
                  rows={2}
                  value={answers[field.id] ?? ''}
                  onChange={(event) => onChange(field.id, event.target.value)}
                />
              ) : field.field_type === 'SELECT' ? (
                <Form.Select
                  value={answers[field.id] ?? ''}
                  onChange={(event) => onChange(field.id, event.target.value)}
                >
                  <option value="">Choose…</option>
                  {(field.options ?? []).map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </Form.Select>
              ) : (
                <Form.Control
                  type={
                    field.field_type === 'DATE'
                      ? 'date'
                      : field.field_type === 'NUMBER' || field.field_type === 'CURRENCY'
                        ? 'number'
                        : 'text'
                  }
                  value={answers[field.id] ?? ''}
                  onChange={(event) => onChange(field.id, event.target.value)}
                />
              )}
            </>
          )}
          {field.help_text && <Form.Text muted>{field.help_text}</Form.Text>}
        </Form.Group>
      ))}
    </div>
  )
}

// Full-screen so a form with several fields (e.g. Budget Proposal's four)
// has real room, instead of being squeezed into the task detail modal
// alongside status/notes/attachments. A self-contained save -- posts
// straight to the answers action and hands the refreshed task back via
// onSaved, independent of the task's own status/notes/committed_date save.
function TaskFormModal({ task, show, onHide, onSaved }) {
  const [answers, setAnswers] = useState(() => buildInitialAnswers(task))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [wasShown, setWasShown] = useState(show)

  // Resyncs to the latest saved answers every time the modal transitions to
  // open (not just when the task itself changes) -- otherwise Cancel
  // wouldn't really discard: reopening the same task's form would show the
  // abandoned draft. Adjusting state during render (React's documented
  // pattern for resetting state when a prop changes) rather than an effect,
  // since a post-render effect here would just cost an extra render for the
  // same result.
  if (show !== wasShown) {
    setWasShown(show)
    if (show) {
      setAnswers(buildInitialAnswers(task))
      setError(null)
    }
  }

  const fields = task.form_fields ?? []

  function updateAnswer(fieldId, value) {
    setAnswers((prev) => ({ ...prev, [fieldId]: value }))
  }

  async function handleSave() {
    setSaving(true)
    setError(null)
    try {
      const responses = Object.entries(answers).map(([field, value]) => ({ field: Number(field), value }))
      const updated = await post(`/api/requirements/${task.id}/answers/`, { responses })
      onSaved(updated)
      onHide()
    } catch (err) {
      setError(errorMessage(err, 'Failed to save the form.'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal show={show} onHide={onHide} fullscreen>
      <Modal.Header closeButton>
        <Modal.Title as="h2" className="h5 mb-0">
          {task.label} — Form
        </Modal.Title>
      </Modal.Header>
      <Modal.Body>
        {error && <Alert variant="danger">{error}</Alert>}
        <TaskFormFieldsEditor fields={fields} answers={answers} onChange={updateAnswer} />
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onHide} disabled={saving}>
          Cancel
        </Button>
        <Button variant="primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </Modal.Footer>
    </Modal>
  )
}

// Shown in place of the form fields themselves, in both the read-only and
// editable task detail views -- a compact summary plus the "Fill form"
// button that opens TaskFormModal. Renders nothing for a task with no form.
function TaskFormSection({ task, onFormSaved }) {
  const [showFormModal, setShowFormModal] = useState(false)
  const fields = task.form_fields ?? []
  if (fields.length === 0) return null

  const answeredCount = (task.form_responses ?? []).filter((r) => r.value).length
  const outstanding = hasOutstandingRequiredFields(task)

  return (
    <div className="mb-3">
      <div className="d-flex justify-content-between align-items-center">
        <div className="text-body-secondary small fw-semibold">Form</div>
        <Button size="sm" variant={outstanding ? 'outline-warning' : 'outline-secondary'} onClick={() => setShowFormModal(true)}>
          Fill form
        </Button>
      </div>
      <div className="text-body-secondary small">
        {answeredCount} of {fields.length} field{fields.length === 1 ? '' : 's'} answered
        {outstanding && (
          <Badge bg="warning" text="dark" className="ms-2">
            Required fields outstanding
          </Badge>
        )}
      </div>
      <TaskFormModal
        task={task}
        show={showFormModal}
        onHide={() => setShowFormModal(false)}
        onSaved={onFormSaved}
      />
    </div>
  )
}

function TaskDetailReadOnly({ task, canConfirm, canEdit, saving, onConfirm, onEdit, onHide, onFormSaved }) {
  const awaitingConfirmation =
    task.status === 'COMPLETED'
    && (task.confirmation_authority === 'MANAGER' || task.confirmation_authority === 'PROJECT_MANAGER')
    && !task.confirmed_by

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
          <StatusPill tone={TASK_STATUS_TONE[task.status] ?? 'grey'}>
            {TASK_STATUS_LABELS[task.status] ?? task.status}
          </StatusPill>
        </div>
        <TaskDueDateGroup task={task} />
        {task.committed_date && (
          <div className="mb-3">
            <div className="text-body-secondary small">Committed date</div>
            <div>{new Date(task.committed_date).toLocaleDateString()}</div>
          </div>
        )}
        {canEdit ? (
          <TaskFormSection task={task} onFormSaved={onFormSaved} />
        ) : (
          <TaskFormFieldsReadOnly task={task} />
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
        <TaskAttachmentsSection requirementId={task.id} />
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

function TaskDetailEditForm({ task, canConfirm, canComplete, saving, error, onSave, onConfirm, onHide, onFormSaved }) {
  // Keyed by task.id from the parent, so switching tasks remounts this with
  // fresh initial state instead of needing an effect to resync it.
  const [draftStatus, setDraftStatus] = useState(task.status)
  const [draftNotes, setDraftNotes] = useState(task.notes ?? '')
  const [draftCommittedDate, setDraftCommittedDate] = useState(task.committed_date ?? '')

  const awaitingConfirmation =
    task.status === 'COMPLETED'
    && (task.confirmation_authority === 'MANAGER' || task.confirmation_authority === 'PROJECT_MANAGER')
    && !task.confirmed_by

  function handleSaveClick() {
    // No client-side required-fields pre-check here any more -- the form's
    // own answers are saved independently via TaskFormModal now, not as
    // part of this payload, so this save can't see draft-in-progress answers
    // to check against anyway. The server's own gate (PhaseRequirementSerializer
    // .validate) still rejects completing with fields outstanding, surfaced
    // through the `error` prop below like any other save failure.
    onSave(draftStatus, draftNotes, draftCommittedDate)
  }

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
        {canComplete ? (
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
        ) : (
          <div className="mb-3">
            <div className="text-body-secondary small">Status</div>
            <StatusPill tone={TASK_STATUS_TONE[task.status] ?? 'grey'}>
              {TASK_STATUS_LABELS[task.status] ?? task.status}
            </StatusPill>
            <div className="text-body-secondary small mt-1">{completionResponsibilityMessage(task)}</div>
          </div>
        )}
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
        <TaskFormSection task={task} onFormSaved={onFormSaved} />
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
        <TaskAttachmentsSection requirementId={task.id} />
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
        <Button variant="primary" disabled={saving} onClick={handleSaveClick}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </Modal.Footer>
    </>
  )
}

function TaskDetailForm({ task, canConfirm, canEdit, canComplete, saving, error, onSave, onConfirm, onHide, onFormSaved }) {
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
        onFormSaved={onFormSaved}
      />
    )
  }

  return (
    <TaskDetailEditForm
      task={task}
      canConfirm={canConfirm}
      canComplete={canComplete}
      saving={saving}
      error={error}
      onSave={onSave}
      onConfirm={onConfirm}
      onHide={onHide}
      onFormSaved={onFormSaved}
    />
  )
}

function TaskDetailModal({ task, canConfirm, canEdit, canComplete, saving, error, onSave, onConfirm, onHide, onFormSaved }) {
  return (
    <Modal show={Boolean(task)} onHide={onHide} centered>
      {task && (
        <TaskDetailForm
          key={task.id}
          task={task}
          canConfirm={canConfirm}
          canEdit={canEdit}
          canComplete={canComplete}
          saving={saving}
          error={error}
          onSave={onSave}
          onConfirm={onConfirm}
          onHide={onHide}
          onFormSaved={onFormSaved}
        />
      )}
    </Modal>
  )
}

const TASK_AUTHORITY_OPTIONS = [
  { value: 'REP', label: 'Rep' },
  { value: 'PROJECT_MANAGER', label: 'Project Manager' },
  { value: 'MANAGER', label: 'Manager' },
]

function AddTaskForm({ phaseNum, saving, error, onSave, onHide }) {
  const [label, setLabel] = useState('')
  const [description, setDescription] = useState('')
  const [confirmationAuthority, setConfirmationAuthority] = useState('REP')
  const [dueDate, setDueDate] = useState('')
  const [fields, setFields] = useState([])

  return (
    <Form
      onSubmit={(event) => {
        event.preventDefault()
        onSave({ label, description, confirmationAuthority, dueDate, customFields: formFieldsPayload(fields) })
      }}
    >
      <Modal.Header closeButton>
        <Modal.Title as="h2" className="h5 mb-0">
          Add Task to Phase {phaseNum}
        </Modal.Title>
      </Modal.Header>
      <Modal.Body>
        {error && <Alert variant="danger">{error}</Alert>}
        <Form.Group className="mb-3" controlId="add-task-label">
          <Form.Label>Label</Form.Label>
          <Form.Control value={label} onChange={(event) => setLabel(event.target.value)} required />
        </Form.Group>
        <Form.Group className="mb-3" controlId="add-task-description">
          <Form.Label>Description</Form.Label>
          <Form.Control
            as="textarea"
            rows={2}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Form.Group>
        <Form.Group className="mb-3" controlId="add-task-authority">
          <Form.Label>Confirmation authority</Form.Label>
          <Form.Select
            value={confirmationAuthority}
            onChange={(event) => setConfirmationAuthority(event.target.value)}
          >
            {TASK_AUTHORITY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Form.Select>
        </Form.Group>
        <Form.Group className="mb-3" controlId="add-task-due-date">
          <Form.Label>Due date</Form.Label>
          <Form.Control type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} />
          <Form.Text muted>Optional -- leave blank for no deadline.</Form.Text>
        </Form.Group>
        <hr />
        <FormFieldsEditor fields={fields} setFields={setFields} />
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
  )
}

function AddTaskModal({ phaseNum, saving, error, onSave, onHide }) {
  return (
    <Modal show={phaseNum !== null} onHide={onHide} centered>
      {phaseNum !== null && (
        <AddTaskForm key={phaseNum} phaseNum={phaseNum} saving={saving} error={error} onSave={onSave} onHide={onHide} />
      )}
    </Modal>
  )
}

function PhaseCard({
  phaseNum,
  status,
  progress,
  tasks,
  onOpenTask,
  pendingSignoff,
  onRequestSignoff,
  executionStatus,
  canEditExecutionStatus,
  executionStatusSaving,
  onExecutionStatusChange,
  phase3Complete,
  canAddTask,
  onAddTask,
}) {
  const allComplete = progress.total > 0 && progress.completed === progress.total
  const isPhase3 = phaseNum === 3
  const isPhase4 = phaseNum === 4
  // Phase 3's sign-off is raised automatically (see the execution status
  // Select below) once its execution status reaches Completed -- there's no
  // manual "Request sign-off" button for it. Phase 4's sign-off only makes
  // sense (and is only ever reachable) once Phase 3 has actually completed.
  const canRequestSignoff = !isPhase3 && allComplete && status !== 'COMPLETE' && (!isPhase4 || phase3Complete)
  const hasOverdueTask = tasks.some((task) => task.is_overdue)

  return (
    // Labelled region so each phase's controls are distinguishable from the
    // other three cards' identical ones -- to a screen reader and to an
    // e2e test alike ("Request sign-off" reads the same on every card).
    <Card className="mb-2" role="region" aria-label={`Phase ${phaseNum}`}>
      <Card.Header className="d-flex justify-content-between align-items-center py-2">
        <span className="fw-semibold">Phase {phaseNum}</span>
        <StatusPill tone={PHASE_STATUS_TONE[status] ?? 'grey'}>
          {PHASE_STATUS_LABELS[status] ?? status}
        </StatusPill>
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
        {isPhase3 && (
          <Form.Group className="mb-2" controlId="phase-3-execution-status">
            <Form.Label className="small mb-1">Execution status</Form.Label>
            <Form.Select
              size="sm"
              value={executionStatus ?? 'STARTED'}
              disabled={!canEditExecutionStatus || executionStatusSaving || status === 'COMPLETE'}
              onChange={(event) => onExecutionStatusChange(event.target.value)}
            >
              {EXECUTION_STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Form.Select>
          </Form.Group>
        )}
        <div className="d-flex gap-2">
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
          {canAddTask && (
            <Button size="sm" variant="outline-secondary" onClick={() => onAddTask(phaseNum)}>
              + Add task
            </Button>
          )}
        </div>
      </Card.Body>
    </Card>
  )
}

function ProjectSummaryPanel({ leadId, leadAssignedTo, refreshToken }) {
  const { user } = useAuth()
  const [project, setProject] = useState(null)
  const [loading, setLoading] = useState(true)

  const [editingBudget, setEditingBudget] = useState(false)
  const [budgetDraft, setBudgetDraft] = useState('')
  const [currencyDraft, setCurrencyDraft] = useState('')
  const [budgetSaving, setBudgetSaving] = useState(false)
  const [budgetError, setBudgetError] = useState(null)

  const [notesDraft, setNotesDraft] = useState('')
  const [notesSaving, setNotesSaving] = useState(false)
  const [notesError, setNotesError] = useState(null)

  useEffect(() => {
    let cancelled = false

    async function fetchProject() {
      setLoading(true)
      try {
        const data = await get(`/api/projects/?lead=${leadId}&include_archived=true`)
        const found = data[0] ?? null
        if (cancelled) return
        setProject(found)
        setBudgetDraft(found?.proposed_budget ?? '')
        setCurrencyDraft(found?.currency ?? '')
        setNotesDraft(found?.notes ?? '')
      } catch {
        if (!cancelled) setProject(null)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchProject()
    return () => {
      cancelled = true
    }
  }, [leadId, refreshToken])

  if (loading || !project) {
    return null
  }

  const isAssignedPM = user?.role === 'PROJECT_MANAGER' && project.project_manager === user.id
  const canEditBudget = MANAGER_ROLES.has(user?.role) || isAssignedPM
  const canEditNotes =
    canEditBudget || (user?.role === 'SALES_REP' && leadAssignedTo === user?.id)
  const notesChanged = notesDraft !== (project.notes ?? '')

  async function handleSaveBudget() {
    setBudgetSaving(true)
    setBudgetError(null)
    try {
      const updated = await patch(`/api/projects/${project.id}/`, {
        proposed_budget: budgetDraft === '' ? null : budgetDraft,
        currency: currencyDraft,
      })
      setProject(updated)
      setEditingBudget(false)
    } catch (err) {
      setBudgetError(errorMessage(err, 'Failed to save the budget.'))
    } finally {
      setBudgetSaving(false)
    }
  }

  async function handleSaveNotes() {
    setNotesSaving(true)
    setNotesError(null)
    try {
      const updated = await patch(`/api/projects/${project.id}/`, { notes: notesDraft })
      setProject(updated)
    } catch (err) {
      setNotesError(errorMessage(err, 'Failed to save notes.'))
    } finally {
      setNotesSaving(false)
    }
  }

  return (
    <Card className="mb-4">
      <Card.Body>
        <Row className="gy-3">
          <Col sm={6} md={3}>
            <div className="text-body-secondary small">Proposed budget</div>
            {editingBudget ? (
              <div className="d-flex gap-1">
                <Form.Control
                  size="sm"
                  type="number"
                  step="0.01"
                  style={{ maxWidth: '7rem' }}
                  value={budgetDraft}
                  onChange={(event) => setBudgetDraft(event.target.value)}
                  disabled={budgetSaving}
                />
                <Form.Control
                  size="sm"
                  type="text"
                  placeholder="USD"
                  maxLength={8}
                  style={{ maxWidth: '5rem' }}
                  value={currencyDraft}
                  onChange={(event) => setCurrencyDraft(event.target.value)}
                  disabled={budgetSaving}
                />
              </div>
            ) : (
              <div>
                {project.proposed_budget
                  ? `${project.currency ? `${project.currency} ` : ''}${project.proposed_budget}`
                  : '—'}
              </div>
            )}
            {canEditBudget && (
              <div className="mt-1">
                {editingBudget ? (
                  <>
                    <Button size="sm" variant="link" className="p-0 me-2" disabled={budgetSaving} onClick={handleSaveBudget}>
                      {budgetSaving ? 'Saving…' : 'Save'}
                    </Button>
                    <Button
                      size="sm"
                      variant="link"
                      className="p-0 text-body-secondary"
                      disabled={budgetSaving}
                      onClick={() => {
                        setEditingBudget(false)
                        setBudgetDraft(project.proposed_budget ?? '')
                        setCurrencyDraft(project.currency ?? '')
                      }}
                    >
                      Cancel
                    </Button>
                  </>
                ) : (
                  <Button size="sm" variant="link" className="p-0" onClick={() => setEditingBudget(true)}>
                    Edit
                  </Button>
                )}
              </div>
            )}
            {budgetError && <div className="text-danger small mt-1">{budgetError}</div>}
          </Col>
          <Col sm={6} md={3}>
            <div className="text-body-secondary small">Current phase</div>
            <div>Phase {getCurrentPhaseNumber(project)}</div>
          </Col>
          <Col sm={6} md={3}>
            <div className="text-body-secondary small">Phase 3 execution status</div>
            <div>
              {project.phase_3_execution_status
                ? EXECUTION_STATUS_LABELS[project.phase_3_execution_status] ?? project.phase_3_execution_status
                : '—'}
            </div>
          </Col>
          <Col sm={6} md={3}>
            <div className="text-body-secondary small">Project Manager</div>
            <div>
              <PersonCell name={project.project_manager_username} fallback="Unassigned" />
            </div>
          </Col>
        </Row>
        <div className="mt-3 pt-3 border-top">
          <div className="text-body-secondary small mb-1">Notes</div>
          <Form.Control
            as="textarea"
            rows={2}
            value={notesDraft}
            disabled={!canEditNotes || notesSaving}
            onChange={(event) => setNotesDraft(event.target.value)}
          />
          {canEditNotes && (
            <div className="mt-1">
              <Button
                size="sm"
                variant="outline-secondary"
                disabled={notesSaving || !notesChanged}
                onClick={handleSaveNotes}
              >
                {notesSaving ? 'Saving…' : 'Save notes'}
              </Button>
            </div>
          )}
          {notesError && <div className="text-danger small mt-1">{notesError}</div>}
        </div>
      </Card.Body>
    </Card>
  )
}

function PhaseTracker({ leadId, leadAssignedTo, onProjectChange }) {
  const { user } = useAuth()
  const [searchParams] = useSearchParams()
  const canManageProject = MANAGER_ROLES.has(user?.role)

  const [project, setProject] = useState(null)
  const [loadingProject, setLoadingProject] = useState(true)
  const [projectError, setProjectError] = useState(null)

  // A PM can confirm/edit PROJECT_MANAGER-authority tasks and change
  // execution status only on the project they're assigned to manage --
  // computed once `project` has loaded, since it depends on project.project_manager.
  const isAssignedPM = Boolean(project) && user?.role === 'PROJECT_MANAGER' && project.project_manager === user.id
  const isAssignedRep = user?.role === 'SALES_REP' && user.id === leadAssignedTo
  const canConfirm = MANAGEMENT_ROLES.has(user?.role) || isAssignedPM
  const canEditTasks = canConfirm || isAssignedRep
  const canEditExecutionStatus = MANAGEMENT_ROLES.has(user?.role) || isAssignedPM

  // Mirrors PhaseRequirementSerializer.COMPLETION_ROLE_BY_PHASE: completion
  // is phase-based, not "can edit this task" -- a management role or the
  // wrong one of rep/PM never gets the interactive status control.
  function canCompleteTask(task) {
    if (!task) return false
    if (task.phase === 1 || task.phase === 4) return isAssignedRep
    if (task.phase === 2 || task.phase === 3) return isAssignedPM
    return false
  }

  const [tasks, setTasks] = useState([])

  const [signoffError, setSignoffError] = useState(null)

  const [activeTask, setActiveTask] = useState(null)
  const [taskSaving, setTaskSaving] = useState(false)
  const [taskError, setTaskError] = useState(null)

  const [projectManagers, setProjectManagers] = useState([])
  const [pmSaving, setPmSaving] = useState(false)
  const [pmError, setPmError] = useState(null)

  const [executionStatusSaving, setExecutionStatusSaving] = useState(false)
  const [executionStatusError, setExecutionStatusError] = useState(null)

  const [addTaskPhase, setAddTaskPhase] = useState(null)
  const [addTaskSaving, setAddTaskSaving] = useState(false)
  const [addTaskError, setAddTaskError] = useState(null)

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
    // Lets the sibling ProjectSummaryPanel (proposed_budget/current phase/
    // etc., which fetches independently) know to refetch too -- covers every
    // path that can change those fields, including the Budget Proposal
    // task's auto-population, without threading project state through props.
    onProjectChange?.()
  }

  useEffect(() => {
    if (!canManageProject) {
      return
    }
    let cancelled = false

    async function fetchProjectManagers() {
      try {
        const data = await get('/api/users/?role=PROJECT_MANAGER')
        if (!cancelled) setProjectManagers(data)
      } catch {
        // Assignment dropdown just falls back to "no PMs available".
      }
    }

    fetchProjectManagers()
    return () => {
      cancelled = true
    }
  }, [canManageProject])

  async function handleProjectManagerChange(value) {
    setPmSaving(true)
    setPmError(null)
    try {
      await patch(`/api/projects/${project.id}/`, { project_manager: value ? Number(value) : null })
      await refreshProject()
    } catch (err) {
      setPmError(errorMessage(err, 'Failed to update the project manager.'))
    } finally {
      setPmSaving(false)
    }
  }

  async function handleExecutionStatusChange(newStatus) {
    setExecutionStatusSaving(true)
    setExecutionStatusError(null)
    try {
      // Selecting "Completed" raises the Phase 3 sign-off automatically on
      // the backend (moving phase_3_status to AWAITING_APPROVAL, not
      // COMPLETE) -- nothing more to send here.
      await patch(`/api/projects/${project.id}/`, { phase_3_execution_status: newStatus })
      await refreshProject()
    } catch (err) {
      setExecutionStatusError(errorMessage(err, 'Failed to update the execution status.'))
    } finally {
      setExecutionStatusSaving(false)
    }
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
    } catch (err) {
      setTaskError(errorMessage(err, 'Failed to save the task.'))
    } finally {
      setTaskSaving(false)
    }
  }

  function handleSaveTask(taskStatus, notes, committedDate) {
    applyTaskUpdate({ status: taskStatus, notes, committed_date: committedDate || null })
  }

  // TaskFormModal saves answers through its own endpoint, independent of the
  // task's status/notes/committed_date -- this just reflects the refreshed
  // task (with its new form_responses) back into local state afterward, the
  // same way applyTaskUpdate does for its own PATCHes.
  function handleTaskFormSaved(updatedTask) {
    setTasks((prev) => prev.map((t) => (t.id === updatedTask.id ? updatedTask : t)))
    setActiveTask(updatedTask)
  }

  function handleConfirmTask() {
    applyTaskUpdate({ status: 'COMPLETED' })
  }

  // A "#<id>" reference in the timeline links here with ?task=<id> -- once
  // this project's tasks have loaded, open that one automatically. The ref
  // guard means it only ever auto-opens once per page load, not every time
  // `tasks` re-fetches (e.g. after closing the very modal this just opened).
  const autoOpenedTaskRef = useRef(false)
  useEffect(() => {
    if (autoOpenedTaskRef.current || tasks.length === 0) return
    const taskId = Number(searchParams.get('task'))
    if (!taskId) return
    const match = tasks.find((t) => t.id === taskId)
    if (match) {
      autoOpenedTaskRef.current = true
      openTask(match)
    }
  }, [tasks, searchParams])

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
    } catch (err) {
      setSignoffError(errorMessage(err, `Failed to request phase ${phaseNum} sign-off.`))
    }
  }

  async function handleAddTask({ label, description, confirmationAuthority, dueDate, customFields }) {
    setAddTaskSaving(true)
    setAddTaskError(null)
    try {
      const created = await post('/api/requirements/', {
        project: project.id,
        phase: addTaskPhase,
        label,
        description,
        confirmation_authority: confirmationAuthority,
        due_date: dueDate || null,
        custom_fields: customFields,
      })
      setTasks((prev) => [...prev, created])
      await refreshProject()
      setAddTaskPhase(null)
    } catch (err) {
      setAddTaskError(errorMessage(err, 'Failed to create the task.'))
    } finally {
      setAddTaskSaving(false)
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
          {pmError && <Alert variant="danger">{pmError}</Alert>}
          {executionStatusError && <Alert variant="danger">{executionStatusError}</Alert>}
          <div className="d-flex align-items-center gap-2 mb-3">
            <span className="small text-body-secondary flex-shrink-0">Project Manager</span>
            {canManageProject ? (
              <Form.Select
                size="sm"
                style={{ maxWidth: '14rem' }}
                value={project.project_manager ?? ''}
                disabled={pmSaving}
                onChange={(event) => handleProjectManagerChange(event.target.value)}
                // The adjacent "Project Manager" text is a span, not a label,
                // so this control would otherwise have no accessible name.
                aria-label="Project Manager"
              >
                <option value="">Unassigned</option>
                {projectManagers.map((pm) => (
                  <option key={pm.id} value={pm.id}>
                    {pm.username}
                  </option>
                ))}
              </Form.Select>
            ) : (
              <PersonCell name={project.project_manager_username} fallback="Unassigned" />
            )}
          </div>
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
              executionStatus={project.phase_3_execution_status}
              canEditExecutionStatus={canEditExecutionStatus}
              executionStatusSaving={executionStatusSaving}
              onExecutionStatusChange={handleExecutionStatusChange}
              phase3Complete={project.phase_3_status === 'COMPLETE'}
              canAddTask={canEditTasks}
              onAddTask={setAddTaskPhase}
            />
          ))}
        </>
      )}

      <TaskDetailModal
        task={activeTask}
        canConfirm={canConfirm}
        canEdit={canEditTasks}
        canComplete={canCompleteTask(activeTask)}
        saving={taskSaving}
        error={taskError}
        onSave={handleSaveTask}
        onConfirm={handleConfirmTask}
        onHide={closeTaskModal}
        onFormSaved={handleTaskFormSaved}
      />

      <AddTaskModal
        phaseNum={addTaskPhase}
        saving={addTaskSaving}
        error={addTaskError}
        onSave={handleAddTask}
        onHide={() => setAddTaskPhase(null)}
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
  const [statusChangeReason, setStatusChangeReason] = useState('')
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
        onSave({ name, status, statusChangeReason, contactId, assignedTo })
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
            <>
              <Form.Select value={status} onChange={(event) => setStatus(event.target.value)}>
                <option value="HOT">Hot</option>
                <option value="COLD">Cold</option>
              </Form.Select>
              {status !== lead.status && (
                <div className="mt-2">
                  <Form.Label className="small mb-1" htmlFor="edit-lead-status-reason">
                    Reason for status change
                  </Form.Label>
                  <Form.Control
                    id="edit-lead-status-reason"
                    as="textarea"
                    rows={2}
                    value={statusChangeReason}
                    onChange={(event) => setStatusChangeReason(event.target.value)}
                    required
                  />
                </div>
              )}
            </>
          ) : (
            <div>
              <StatusPill tone={LEAD_STATUS_TONE[lead.status] ?? 'grey'}>{lead.status}</StatusPill>
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

  async function handleSave({ name, status, statusChangeReason, contactId, assignedTo }) {
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
        // Only sent when the status is actually changing -- the backend
        // only requires (and only reads) this alongside a real change.
        if (status !== lead.status) {
          payload.status_change_reason = statusChangeReason
        }
      }
      if (canEditAssignedTo) {
        payload.assigned_to = Number(assignedTo)
      }
      const updated = await patch(`/api/leads/${lead.id}/`, payload)
      onSaved(updated)
      onHide()
    } catch (err) {
      setError(errorMessage(err, 'Failed to save lead.'))
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

function StatusChangeRequestForm({ currentStatus, saving, error, onSave, onHide }) {
  const otherStatus = currentStatus === 'HOT' ? 'COLD' : 'HOT'
  const [targetStatus, setTargetStatus] = useState(otherStatus)
  const [reason, setReason] = useState('')

  return (
    <Form
      onSubmit={(event) => {
        event.preventDefault()
        onSave(targetStatus, reason)
      }}
    >
      <Modal.Header closeButton>
        <Modal.Title as="h2" className="h5 mb-0">
          Request Status Change
        </Modal.Title>
      </Modal.Header>
      <Modal.Body>
        {error && <Alert variant="danger">{error}</Alert>}
        <Form.Group className="mb-3" controlId="status-change-target">
          <Form.Label>New status</Form.Label>
          <Form.Select value={targetStatus} onChange={(event) => setTargetStatus(event.target.value)}>
            <option value="HOT">Hot</option>
            <option value="COLD">Cold</option>
          </Form.Select>
        </Form.Group>
        <Form.Group controlId="status-change-reason">
          <Form.Label>Reason</Form.Label>
          <Form.Control
            as="textarea"
            rows={3}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            required
          />
        </Form.Group>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onHide} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={saving}>
          {saving ? 'Submitting…' : 'Submit request'}
        </Button>
      </Modal.Footer>
    </Form>
  )
}

function StatusChangeRequestModal({ show, currentStatus, saving, error, onSave, onHide }) {
  return (
    <Modal show={show} onHide={onHide} centered>
      <StatusChangeRequestForm
        key={show}
        currentStatus={currentStatus}
        saving={saving}
        error={error}
        onSave={onSave}
        onHide={onHide}
      />
    </Modal>
  )
}

// Splits every plain-string element of `segments` on `pattern` (which must
// have exactly one capturing group around the whole token, so String.split
// interleaves the matches into the result), replacing each match with
// `makeTag(matchedText)`. Already-tagged (non-string) elements are passed
// through untouched -- lets @mention and #task passes run one after another
// over the same notes without either one re-processing the other's output.
function splitAndTag(segments, pattern, makeTag) {
  const result = []
  for (const segment of segments) {
    if (typeof segment !== 'string') {
      result.push(segment)
      continue
    }
    segment.split(pattern).forEach((part, index) => {
      if (part === '') return
      result.push(index % 2 === 1 ? makeTag(part) : part)
    })
  }
  return result
}

// Renders interaction notes as plain text, except: any "@username" token
// naming a user this interaction actually mentioned (per the backend's own
// parsing -- see mentionedUsernames, from Interaction.mentioned_usernames)
// is highlighted, and any "#<id>" token that resolved to a real task on this
// lead's project (see referencedTasks, from Interaction.referenced_tasks)
// becomes a link to that task. Deliberately not a client-side re-parse of
// raw "@word"/"#word" text -- that would highlight/link things the backend
// itself didn't recognize, misrepresenting what's actually there.
function NotesWithMentions({ notes, mentionedUsernames, referencedTasks, leadId }) {
  if (!notes) return null
  const hasMentions = mentionedUsernames && mentionedUsernames.length > 0
  const hasTasks = referencedTasks && referencedTasks.length > 0
  if (!hasMentions && !hasTasks) {
    return <p className="mb-1">{notes}</p>
  }

  let segments = [notes]
  if (hasMentions) {
    const escaped = mentionedUsernames.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    const pattern = new RegExp(`((?:^|(?<=\\s))@(?:${escaped.join('|')})\\b)`, 'gi')
    segments = splitAndTag(segments, pattern, (text) => ({ type: 'mention', text }))
  }
  if (hasTasks) {
    const ids = referencedTasks.map((task) => task.id).join('|')
    const pattern = new RegExp(`((?:^|(?<=\\s))#(?:${ids})\\b)`, 'g')
    segments = splitAndTag(segments, pattern, (text) => {
      const task = referencedTasks.find((t) => t.id === Number(text.slice(1)))
      return { type: 'task', text, task }
    })
  }

  return (
    <p className="mb-1">
      {segments.map((segment, index) => {
        if (typeof segment === 'string') return <span key={index}>{segment}</span>
        if (segment.type === 'mention') {
          return (
            <span key={index} className="fw-semibold text-primary">
              {segment.text}
            </span>
          )
        }
        return (
          <Link key={index} to={`/leads/${leadId}?tab=phases&task=${segment.task.id}`} className="fw-semibold">
            #{segment.task.label}
          </Link>
        )
      })}
    </p>
  )
}

const MENTION_AUTOCOMPLETE_LIMIT = 6

// A plain textarea, except typing "@" opens an autocomplete of /api/users/
// (inserting "@username ") and typing "#" opens one of this lead's tasks
// (inserting "#<id> ", so the same token PhaseRequirementSerializer's
// mention parsing and InteractionSerializer.referenced_tasks both read back)
// -- each filtered by whatever's typed after the trigger.
function MentionAutocompleteTextarea({ leadId, value, onChange, ...controlProps }) {
  const [users, setUsers] = useState([])
  const [tasks, setTasks] = useState([])
  // { trigger: '@' | '#', query, start, end } or null.
  const [suggestion, setSuggestion] = useState(null)
  const textareaRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    async function fetchUsers() {
      try {
        const data = await get('/api/users/')
        if (!cancelled) setUsers(data)
      } catch {
        if (!cancelled) setUsers([])
      }
    }
    fetchUsers()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    async function fetchTasks() {
      try {
        const projects = await get(`/api/projects/?lead=${leadId}`)
        const project = projects[0]
        const data = project ? await get(`/api/requirements/?project=${project.id}`) : []
        if (!cancelled) setTasks(data)
      } catch {
        if (!cancelled) setTasks([])
      }
    }
    fetchTasks()
    return () => {
      cancelled = true
    }
  }, [leadId])

  function updateSuggestion(text, cursor) {
    const uptoCursor = text.slice(0, cursor)
    const userMatch = uptoCursor.match(/(?:^|\s)@(\w*)$/)
    if (userMatch) {
      setSuggestion({ trigger: '@', query: userMatch[1], start: cursor - userMatch[1].length - 1, end: cursor })
      return
    }
    const taskMatch = uptoCursor.match(/(?:^|\s)#(\w*)$/)
    if (taskMatch) {
      setSuggestion({ trigger: '#', query: taskMatch[1], start: cursor - taskMatch[1].length - 1, end: cursor })
      return
    }
    setSuggestion(null)
  }

  function handleChange(event) {
    onChange(event)
    updateSuggestion(event.target.value, event.target.selectionStart)
  }

  function insertToken(token) {
    const before = value.slice(0, suggestion.start)
    const after = value.slice(suggestion.end)
    onChange({ target: { value: `${before}${token} ${after}` } })
    setSuggestion(null)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      const caret = before.length + token.length + 1
      el.focus()
      el.setSelectionRange(caret, caret)
    })
  }

  const userMatches =
    suggestion?.trigger === '@'
      ? users
          .filter((u) => u.username.toLowerCase().startsWith(suggestion.query.toLowerCase()))
          .slice(0, MENTION_AUTOCOMPLETE_LIMIT)
      : []
  const taskMatches =
    suggestion?.trigger === '#'
      ? tasks
          .filter((t) => t.label.toLowerCase().includes(suggestion.query.toLowerCase()))
          .slice(0, MENTION_AUTOCOMPLETE_LIMIT)
      : []

  return (
    <div className="position-relative">
      <Form.Control
        {...controlProps}
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        // Delayed so a suggestion's onClick (which itself fires on mousedown
        // via preventDefault below) still lands before the dropdown closes.
        onBlur={() => setTimeout(() => setSuggestion(null), 150)}
      />
      {userMatches.length > 0 && (
        <ListGroup className="position-absolute shadow-sm" style={{ zIndex: 1060, minWidth: '12rem', top: '100%' }}>
          {userMatches.map((u) => (
            <ListGroup.Item
              key={u.id}
              action
              as="button"
              type="button"
              className="py-1"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => insertToken(`@${u.username}`)}
            >
              @{u.username}
            </ListGroup.Item>
          ))}
        </ListGroup>
      )}
      {taskMatches.length > 0 && (
        <ListGroup className="position-absolute shadow-sm" style={{ zIndex: 1060, minWidth: '16rem', top: '100%' }}>
          {taskMatches.map((t) => (
            <ListGroup.Item
              key={t.id}
              action
              as="button"
              type="button"
              className="py-1"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => insertToken(`#${t.id}`)}
            >
              #{t.id} · {t.label}
            </ListGroup.Item>
          ))}
        </ListGroup>
      )}
    </div>
  )
}

export default function LeadDetail() {
  const { id } = useParams()
  const { user } = useAuth()
  // Lets a notification-centre link land straight on the Activity tab
  // (e.g. /leads/12?tab=activity) instead of always opening on Phases.
  const [searchParams] = useSearchParams()
  const initialTab = searchParams.get('tab') === 'activity' ? 'activity' : 'phases'

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
  const canRequestStatusChange =
    Boolean(lead) && user?.role === 'SALES_REP' && lead.assigned_to === user.id

  const [showStatusChangeModal, setShowStatusChangeModal] = useState(false)
  const [statusChangeSaving, setStatusChangeSaving] = useState(false)
  const [statusChangeError, setStatusChangeError] = useState(null)
  const [pendingStatusChangeRequest, setPendingStatusChangeRequest] = useState(null)

  // Bumped whenever PhaseTracker refreshes the project (task completion, PM
  // assignment, execution status, phase changes) so ProjectSummaryPanel --
  // which fetches the project independently -- knows to refetch too.
  const [projectRefreshToken, setProjectRefreshToken] = useState(0)
  const bumpProjectRefresh = () => setProjectRefreshToken((token) => token + 1)

  usePageMeta({
    // Falls back to the layout's route title until the lead arrives.
    title: lead?.name ?? 'Lead',
    badge: lead?.is_archived ? 'Archived' : null,
    breadcrumbs: lead
      ? [
          { label: 'Leads', to: '/leads' },
          { label: lead.company_name ?? '—', to: lead.company ? `/companies/${lead.company}` : undefined },
        ]
      : null,
  })

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

  async function refreshPendingStatusChangeRequest() {
    try {
      const data = await get('/api/approvals/?request_type=LEAD_STATUS_CHANGE&status=PENDING')
      setPendingStatusChangeRequest(data.find((row) => row.lead === Number(id)) ?? null)
    } catch {
      setPendingStatusChangeRequest(null)
    }
  }

  useEffect(() => {
    if (!canRequestStatusChange) {
      return
    }
    let cancelled = false

    async function fetchPendingStatusChangeRequest() {
      try {
        const data = await get('/api/approvals/?request_type=LEAD_STATUS_CHANGE&status=PENDING')
        if (!cancelled) setPendingStatusChangeRequest(data.find((row) => row.lead === Number(id)) ?? null)
      } catch {
        if (!cancelled) setPendingStatusChangeRequest(null)
      }
    }

    fetchPendingStatusChangeRequest()
    return () => {
      cancelled = true
    }
  }, [canRequestStatusChange, id])

  async function handleRequestStatusChange(targetStatus, reason) {
    setStatusChangeSaving(true)
    setStatusChangeError(null)
    try {
      await post('/api/approvals/', {
        request_type: 'LEAD_STATUS_CHANGE',
        lead: Number(id),
        target_status: targetStatus,
        reason,
      })
      setShowStatusChangeModal(false)
      await Promise.all([refreshPendingStatusChangeRequest(), refreshTimeline()])
    } catch (err) {
      setStatusChangeError(errorMessage(err, 'Failed to submit the status change request.'))
    } finally {
      setStatusChangeSaving(false)
    }
  }

  async function handleSubmit(event) {
    event.preventDefault()
    setSubmitting(true)
    setSubmitError(null)
    try {
      await post('/api/interactions/', { lead: Number(id), type, notes, ...(type !== 'NOTE' && { outcome }) })
      setNotes('')
      await Promise.all([refreshLead(), refreshTimeline()])
    } catch (err) {
      setSubmitError(errorMessage(err, 'Failed to log interaction.'))
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
              {lead.contact_name ? (
                <>
                  <div className="d-flex align-items-center gap-2">
                    <Avatar name={lead.contact_name} size="sm" />
                    <span>{lead.contact_name}</span>
                  </div>
                  <ContactDetails
                    email={lead.contact_email}
                    phone={lead.contact_phone}
                    name={lead.contact_name}
                  />
                </>
              ) : (
                <p className="text-body-secondary mb-0">No contact</p>
              )}
            </div>
            <div className="d-flex align-items-center gap-2">
              {/* The pill's text content is the status word and nothing
                  else (its dot is an empty aria-hidden span), so as a
                  button it still announces as "HOT"/"COLD". */}
              {canRequestStatusChange && !pendingStatusChangeRequest ? (
                <StatusPill
                  as="button"
                  type="button"
                  tone={LEAD_STATUS_TONE[lead.status] ?? 'grey'}
                  onClick={() => setShowStatusChangeModal(true)}
                  title="Click to request a status change"
                >
                  {lead.status}
                </StatusPill>
              ) : (
                <StatusPill tone={LEAD_STATUS_TONE[lead.status] ?? 'grey'}>{lead.status}</StatusPill>
              )}
              {pendingStatusChangeRequest && (
                <Badge bg="warning" pill title={pendingStatusChangeRequest.reason}>
                  Change to {pendingStatusChangeRequest.target_status} pending
                </Badge>
              )}
              {canEdit && (
                // Named explicitly: the project panel below has its own
                // "Edit" (for the budget), so a bare "Edit" is ambiguous.
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Edit lead"
                  title="Edit lead"
                  onClick={() => setShowEditModal(true)}
                >
                  <Pencil size={15} aria-hidden="true" />
                </button>
              )}
              <ArchiveButton resource="lead" record={lead} onArchived={refreshLead} label="Archive lead" />
            </div>
          </div>

          <ProjectSummaryPanel
            leadId={lead.id}
            leadAssignedTo={lead.assigned_to}
            refreshToken={projectRefreshToken}
          />

          <Row className="mb-4 gy-2">
            <Col sm={6} md={3}>
              <div className="text-body-secondary small">Assigned to</div>
              <div>
                <PersonCell name={lead.assigned_to_username} fallback="Unassigned" />
              </div>
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

          {canRequestStatusChange && (
            <StatusChangeRequestModal
              show={showStatusChangeModal}
              currentStatus={lead.status}
              saving={statusChangeSaving}
              error={statusChangeError}
              onSave={handleRequestStatusChange}
              onHide={() => setShowStatusChangeModal(false)}
            />
          )}

          <Tabs defaultActiveKey={initialTab} id="lead-detail-tabs" className="mb-4">
            <Tab eventKey="phases" title="Phases">
              <PhaseTracker
                leadId={lead.id}
                leadAssignedTo={lead.assigned_to}
                onProjectChange={bumpProjectRefresh}
              />
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
                          <MentionAutocompleteTextarea
                            leadId={id}
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
                        <NotesWithMentions
                          notes={entry.notes}
                          mentionedUsernames={entry.mentioned_usernames}
                          referencedTasks={entry.referenced_tasks}
                          leadId={id}
                        />
                        <div className="text-body-secondary small">
                          <Avatar name={entry.created_by_username} size="sm" className="me-1" />
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
