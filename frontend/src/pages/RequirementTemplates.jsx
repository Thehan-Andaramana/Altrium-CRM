import { useEffect, useState } from 'react'
import Alert from 'react-bootstrap/Alert'
import Badge from 'react-bootstrap/Badge'
import Button from 'react-bootstrap/Button'
import Card from 'react-bootstrap/Card'
import Form from 'react-bootstrap/Form'
import ListGroup from 'react-bootstrap/ListGroup'
import Modal from 'react-bootstrap/Modal'
import Spinner from 'react-bootstrap/Spinner'
import { get, patch, post } from '../api'
import { useAuth } from '../AuthContext.jsx'

const MANAGEMENT_ROLES = new Set(['SALES_MANAGER', 'EXECUTIVE_MANAGER', 'SYSTEM_ADMIN'])
const PHASE_NUMBERS = [1, 2, 3]

const AUTHORITY_OPTIONS = [
  { value: 'REP', label: 'Rep' },
  { value: 'MANAGER', label: 'Manager' },
]

function UpDownIcon({ direction, ...props }) {
  const d = direction === 'up' ? 'M8 4 3.5 10.5h9z' : 'M8 12 3.5 5.5h9z'
  return (
    <svg viewBox="0 0 16 16" width="1em" height="1em" fill="currentColor" aria-hidden="true" {...props}>
      <path d={d} />
    </svg>
  )
}

function TemplateFormFields({ label, setLabel, description, setDescription, durationDays, setDurationDays }) {
  return (
    <>
      <Form.Group className="mb-3" controlId="template-label">
        <Form.Label>Label</Form.Label>
        <Form.Control value={label} onChange={(event) => setLabel(event.target.value)} required />
      </Form.Group>
      <Form.Group className="mb-3" controlId="template-description">
        <Form.Label>Description</Form.Label>
        <Form.Control
          as="textarea"
          rows={3}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </Form.Group>
      <Form.Group controlId="template-duration">
        <Form.Label>Default duration (days)</Form.Label>
        <Form.Control
          type="number"
          min="1"
          step="1"
          placeholder="No deadline"
          value={durationDays}
          onChange={(event) => setDurationDays(event.target.value)}
        />
        <Form.Text className="text-body-secondary">
          Days from the phase's start until this task is due. Leave blank for no deadline.
        </Form.Text>
      </Form.Group>
    </>
  )
}

function EditTemplateForm({ template, saving, error, onSave, onHide }) {
  // Keyed by template.id from the parent, so switching templates remounts
  // this with fresh initial state instead of needing an effect to resync it.
  const [label, setLabel] = useState(template.label)
  const [description, setDescription] = useState(template.description ?? '')
  const [durationDays, setDurationDays] = useState(
    template.default_duration_days != null ? String(template.default_duration_days) : '',
  )

  return (
    <Form
      onSubmit={(event) => {
        event.preventDefault()
        onSave({ label, description, durationDays })
      }}
    >
      <Modal.Header closeButton>
        <Modal.Title as="h2" className="h5 mb-0">
          Edit Task
        </Modal.Title>
      </Modal.Header>
      <Modal.Body>
        {error && <Alert variant="danger">{error}</Alert>}
        <TemplateFormFields
          label={label}
          setLabel={setLabel}
          description={description}
          setDescription={setDescription}
          durationDays={durationDays}
          setDurationDays={setDurationDays}
        />
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

function EditTemplateModal({ template, saving, error, onSave, onHide }) {
  return (
    <Modal show={Boolean(template)} onHide={onHide} centered>
      {template && (
        <EditTemplateForm key={template.id} template={template} saving={saving} error={error} onSave={onSave} onHide={onHide} />
      )}
    </Modal>
  )
}

function AddTemplateModal({ phase, saving, error, onSave, onHide }) {
  const [label, setLabel] = useState('')
  const [description, setDescription] = useState('')
  const [durationDays, setDurationDays] = useState('')

  return (
    <Modal show onHide={onHide} centered>
      <Form
        onSubmit={(event) => {
          event.preventDefault()
          onSave({ label, description, durationDays })
        }}
      >
        <Modal.Header closeButton>
          <Modal.Title as="h2" className="h5 mb-0">
            Add Task to Phase {phase}
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {error && <Alert variant="danger">{error}</Alert>}
          <TemplateFormFields
            label={label}
            setLabel={setLabel}
            description={description}
            setDescription={setDescription}
            durationDays={durationDays}
            setDurationDays={setDurationDays}
          />
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

function TemplateRow({
  template,
  isFirst,
  isLast,
  busy,
  onMove,
  onEdit,
  onToggleActive,
  onAuthorityChange,
  onClientFacingChange,
  onDurationChange,
}) {
  return (
    <ListGroup.Item className="d-flex align-items-center gap-2">
      <div className="d-flex flex-column">
        <Button
          variant="link"
          size="sm"
          className="p-0 lh-1"
          disabled={isFirst || busy}
          onClick={() => onMove(template, 'up')}
          aria-label={`Move ${template.label} up`}
        >
          <UpDownIcon direction="up" />
        </Button>
        <Button
          variant="link"
          size="sm"
          className="p-0 lh-1"
          disabled={isLast || busy}
          onClick={() => onMove(template, 'down')}
          aria-label={`Move ${template.label} down`}
        >
          <UpDownIcon direction="down" />
        </Button>
      </div>
      <div className="flex-grow-1">
        <div>
          {template.label}
          {!template.is_active && (
            <Badge bg="secondary" className="ms-2">
              Inactive
            </Badge>
          )}
        </div>
        {template.description && <div className="text-body-secondary small">{template.description}</div>}
      </div>
      <div className="d-flex align-items-center gap-1">
        <Form.Label htmlFor={`duration-${template.id}`} className="mb-0 small text-nowrap">
          Due after
        </Form.Label>
        <Form.Control
          // Uncontrolled + keyed on the committed value, so typing doesn't
          // fire a PATCH (and disable the field) after every keystroke --
          // only on blur/Enter. The key forces it to pick up external
          // changes (a successful save, or someone else's edit) by remounting.
          key={template.default_duration_days ?? 'none'}
          id={`duration-${template.id}`}
          type="number"
          size="sm"
          min="1"
          step="1"
          style={{ width: '4.5rem' }}
          placeholder="None"
          defaultValue={template.default_duration_days ?? ''}
          disabled={busy}
          onBlur={(event) => onDurationChange(template, event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              event.target.blur()
            }
          }}
          aria-label={`Due after (days) for ${template.label}`}
        />
        <span className="small text-body-secondary text-nowrap">days</span>
      </div>
      <Form.Select
        size="sm"
        style={{ maxWidth: '10rem' }}
        value={template.confirmation_authority}
        disabled={busy}
        onChange={(event) => onAuthorityChange(template, event.target.value)}
        aria-label={`Confirmation authority for ${template.label}`}
      >
        {AUTHORITY_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Form.Select>
      <Form.Check
        type="checkbox"
        id={`client-facing-${template.id}`}
        label="Client-facing"
        checked={template.client_facing}
        disabled={busy}
        onChange={(event) => onClientFacingChange(template, event.target.checked)}
        title="Marks this task as representing confirmed client contact -- completing it updates the lead the same way a client interaction does."
      />
      <Button variant="outline-secondary" size="sm" disabled={busy} onClick={() => onEdit(template)}>
        Edit
      </Button>
      <Button
        variant={template.is_active ? 'outline-danger' : 'outline-success'}
        size="sm"
        disabled={busy}
        onClick={() => onToggleActive(template)}
      >
        {template.is_active ? 'Deactivate' : 'Activate'}
      </Button>
    </ListGroup.Item>
  )
}

export default function RequirementTemplates() {
  const { user } = useAuth()
  const allowed = MANAGEMENT_ROLES.has(user?.role)

  const [templates, setTemplates] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [busyId, setBusyId] = useState(null)
  const [rowError, setRowError] = useState(null)

  const [editingTemplate, setEditingTemplate] = useState(null)
  const [editSaving, setEditSaving] = useState(false)
  const [editError, setEditError] = useState(null)

  const [addPhase, setAddPhase] = useState(null)
  const [addSaving, setAddSaving] = useState(false)
  const [addError, setAddError] = useState(null)

  useEffect(() => {
    if (!allowed) {
      return
    }
    let cancelled = false

    async function fetchTemplates() {
      setLoading(true)
      setError(null)
      try {
        const data = await get('/api/requirement-templates/')
        if (!cancelled) setTemplates(data)
      } catch {
        if (!cancelled) setError('Failed to load requirement templates.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchTemplates()
    return () => {
      cancelled = true
    }
  }, [allowed])

  function templatesForPhase(phase) {
    return templates
      .filter((t) => t.phase === phase)
      .slice()
      .sort((a, b) => a.order - b.order)
  }

  async function handleMove(template, direction) {
    const siblings = templatesForPhase(template.phase)
    const index = siblings.findIndex((t) => t.id === template.id)
    const swapWith = direction === 'up' ? siblings[index - 1] : siblings[index + 1]
    if (!swapWith) return

    setBusyId(template.id)
    setRowError(null)
    try {
      const [updatedA, updatedB] = await Promise.all([
        patch(`/api/requirement-templates/${template.id}/`, { order: swapWith.order }),
        patch(`/api/requirement-templates/${swapWith.id}/`, { order: template.order }),
      ])
      setTemplates((prev) =>
        prev.map((t) => {
          if (t.id === updatedA.id) return updatedA
          if (t.id === updatedB.id) return updatedB
          return t
        }),
      )
    } catch {
      setRowError('Failed to reorder tasks.')
    } finally {
      setBusyId(null)
    }
  }

  async function handleToggleActive(template) {
    setBusyId(template.id)
    setRowError(null)
    try {
      const updated = await patch(`/api/requirement-templates/${template.id}/`, {
        is_active: !template.is_active,
      })
      setTemplates((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))
    } catch {
      setRowError('Failed to update the task.')
    } finally {
      setBusyId(null)
    }
  }

  async function handleAuthorityChange(template, authority) {
    setBusyId(template.id)
    setRowError(null)
    try {
      const updated = await patch(`/api/requirement-templates/${template.id}/`, {
        confirmation_authority: authority,
      })
      setTemplates((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))
    } catch {
      setRowError('Failed to update confirmation authority.')
    } finally {
      setBusyId(null)
    }
  }

  async function handleClientFacingChange(template, clientFacing) {
    setBusyId(template.id)
    setRowError(null)
    try {
      const updated = await patch(`/api/requirement-templates/${template.id}/`, {
        client_facing: clientFacing,
      })
      setTemplates((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))
    } catch {
      setRowError('Failed to update the client-facing flag.')
    } finally {
      setBusyId(null)
    }
  }

  async function handleDurationChange(template, rawValue) {
    const parsed = rawValue === '' ? null : Number(rawValue)
    if (parsed === (template.default_duration_days ?? null)) {
      return
    }
    setBusyId(template.id)
    setRowError(null)
    try {
      const updated = await patch(`/api/requirement-templates/${template.id}/`, {
        default_duration_days: parsed,
      })
      setTemplates((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))
    } catch {
      setRowError('Failed to update the due-after duration.')
    } finally {
      setBusyId(null)
    }
  }

  async function handleEditSave({ durationDays, ...payload }) {
    setEditSaving(true)
    setEditError(null)
    try {
      const updated = await patch(`/api/requirement-templates/${editingTemplate.id}/`, {
        ...payload,
        default_duration_days: durationDays === '' ? null : Number(durationDays),
      })
      setTemplates((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))
      setEditingTemplate(null)
    } catch {
      setEditError('Failed to save the task.')
    } finally {
      setEditSaving(false)
    }
  }

  async function handleAddSave({ durationDays, ...payload }) {
    setAddSaving(true)
    setAddError(null)
    try {
      const siblings = templatesForPhase(addPhase)
      const maxOrder = siblings.reduce((max, t) => Math.max(max, t.order), 0)
      const created = await post('/api/requirement-templates/', {
        ...payload,
        default_duration_days: durationDays === '' ? null : Number(durationDays),
        phase: addPhase,
        order: maxOrder + 1,
        confirmation_authority: 'REP',
      })
      setTemplates((prev) => [...prev, created])
      setAddPhase(null)
    } catch {
      setAddError('Failed to create the task.')
    } finally {
      setAddSaving(false)
    }
  }

  return (
    <>
      <p className="text-body-secondary small">
        "Client-facing" marks a task as representing confirmed client contact — completing one updates the lead
        the same way logging a client interaction does. Leave it off for internal-only tasks.
      </p>
      {error && <Alert variant="danger">{error}</Alert>}
      {rowError && <Alert variant="danger">{rowError}</Alert>}

      {loading ? (
        <div className="d-flex justify-content-center py-5">
          <Spinner animation="border" role="status">
            <span className="visually-hidden">Loading…</span>
          </Spinner>
        </div>
      ) : (
        PHASE_NUMBERS.map((phase) => {
          const phaseTemplates = templatesForPhase(phase)
          return (
            <Card key={phase} className="mb-3">
              <Card.Header className="d-flex justify-content-between align-items-center">
                <span className="fw-semibold">Phase {phase}</span>
                <Button size="sm" variant="outline-primary" onClick={() => setAddPhase(phase)}>
                  + Add task
                </Button>
              </Card.Header>
              <Card.Body className="p-0">
                {phaseTemplates.length === 0 ? (
                  <p className="text-body-secondary p-3 mb-0">No tasks defined for this phase.</p>
                ) : (
                  <ListGroup variant="flush">
                    {phaseTemplates.map((template, index) => (
                      <TemplateRow
                        key={template.id}
                        template={template}
                        isFirst={index === 0}
                        isLast={index === phaseTemplates.length - 1}
                        busy={busyId === template.id}
                        onMove={handleMove}
                        onEdit={setEditingTemplate}
                        onToggleActive={handleToggleActive}
                        onAuthorityChange={handleAuthorityChange}
                        onClientFacingChange={handleClientFacingChange}
                        onDurationChange={handleDurationChange}
                      />
                    ))}
                  </ListGroup>
                )}
              </Card.Body>
            </Card>
          )
        })
      )}

      <EditTemplateModal
        template={editingTemplate}
        saving={editSaving}
        error={editError}
        onSave={handleEditSave}
        onHide={() => setEditingTemplate(null)}
      />

      {addPhase !== null && (
        <AddTemplateModal
          phase={addPhase}
          saving={addSaving}
          error={addError}
          onSave={handleAddSave}
          onHide={() => setAddPhase(null)}
        />
      )}
    </>
  )
}
