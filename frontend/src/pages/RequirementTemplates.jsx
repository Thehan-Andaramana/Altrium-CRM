import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { FilePlus2, FileText, GripVertical } from 'lucide-react'
import { useEffect, useState } from 'react'
import Alert from 'react-bootstrap/Alert'
import Badge from 'react-bootstrap/Badge'
import Button from 'react-bootstrap/Button'
import Form from 'react-bootstrap/Form'
import InputGroup from 'react-bootstrap/InputGroup'
import ListGroup from 'react-bootstrap/ListGroup'
import Spinner from 'react-bootstrap/Spinner'
import { errorMessage, get, patch, post } from '../api'
import { useAuth } from '../AuthContext.jsx'
import AppModal from '../components/AppModal.jsx'
import FormField from '../components/FormField.jsx'
import FormFieldsEditor, { UpDownIcon } from '../components/FormFieldsEditor.jsx'
import { formFieldsPayload } from '../formFields.js'

const MANAGEMENT_ROLES = new Set(['SALES_MANAGER', 'EXECUTIVE_MANAGER', 'SYSTEM_ADMIN'])
const PHASE_NUMBERS = [1, 2, 3, 4]

// All three of RequirementTemplate.ConfirmationAuthority. Project Manager
// was missing here, so the eight PM-confirmed templates rendered as "Rep"
// (a select falls back to its first option when the value matches none) --
// and picking anything would have silently downgraded them.
const AUTHORITY_OPTIONS = [
  { value: 'REP', label: 'Rep' },
  { value: 'PROJECT_MANAGER', label: 'Project Manager' },
  { value: 'MANAGER', label: 'Manager' },
]

function TemplateFormFields({ label, setLabel, description, setDescription }) {
  return (
    <>
      <FormField label="Label" controlId="template-label" required>
        <Form.Control value={label} onChange={(event) => setLabel(event.target.value)} required />
      </FormField>
      <FormField label="Description" controlId="template-description">
        <Form.Control
          as="textarea"
          rows={3}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </FormField>
    </>
  )
}

function EditTemplateForm({ template, saving, error, onSave, onHide }) {
  // Keyed by template.id from the parent, so switching templates remounts
  // this with fresh initial state instead of needing an effect to resync it.
  const [label, setLabel] = useState(template.label)
  const [description, setDescription] = useState(template.description ?? '')
  const [fields, setFields] = useState(() => (template.form_fields ?? []).map((f) => ({ ...f, key: f.id })))

  return (
    <AppModal
      onHide={onHide}
      size="lg"
      scrollable
      icon={FileText}
      title="Edit Task"
      subtitle="Every new project gets this task, with the form fields below."
      onSubmit={(event) => {
        event.preventDefault()
        onSave({ label, description, form_fields: formFieldsPayload(fields) })
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
      <TemplateFormFields
        label={label}
        setLabel={setLabel}
        description={description}
        setDescription={setDescription}
      />
      <hr className="my-4" />
      <FormFieldsEditor fields={fields} setFields={setFields} />
    </AppModal>
  )
}

function EditTemplateModal({ template, saving, error, onSave, onHide }) {
  // The form owns the dialog, so the key gives a different template fresh
  // fields rather than the previous one's.
  if (!template) {
    return null
  }
  return (
    <EditTemplateForm
      key={template.id}
      template={template}
      saving={saving}
      error={error}
      onSave={onSave}
      onHide={onHide}
    />
  )
}

function AddTemplateModal({ phase, saving, error, onSave, onHide }) {
  const [label, setLabel] = useState('')
  const [description, setDescription] = useState('')
  const [fields, setFields] = useState([])

  return (
    <AppModal
      onHide={onHide}
      size="lg"
      scrollable
      icon={FilePlus2}
      title={`Add Task to Phase ${phase}`}
      subtitle="Every new project will get this task from now on."
      onSubmit={(event) => {
        event.preventDefault()
        onSave({ label, description, form_fields: formFieldsPayload(fields) })
      }}
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
      <TemplateFormFields
        label={label}
        setLabel={setLabel}
        description={description}
        setDescription={setDescription}
      />
      <hr className="my-4" />
      <FormFieldsEditor fields={fields} setFields={setFields} />
    </AppModal>
  )
}

// Where a dragged template came from decides what dropping it does.
const PHASE_DROP_PREFIX = 'phase:'
const PANEL_DROP_ID = 'template-library-panel'

function PhaseDropZone({ phase, isOver, children, onAdd }) {
  return (
    <section
      className={`template-phase ${isOver ? 'template-phase--over' : ''}`.trim()}
      aria-label={`Phase ${phase} templates`}
    >
      <header className="template-phase__header">
        <h3 className="template-phase__title">Phase {phase}</h3>
        <Button size="sm" variant="outline-secondary" onClick={() => onAdd(phase)}>
          + Add task
        </Button>
      </header>
      {children}
    </section>
  )
}

// A draggable handle beside a row or a panel card. The handle, not the whole
// element, starts the drag -- the rows carry selects, inputs and buttons
// that would otherwise be impossible to use.
function DragHandle({ id, data, label }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id, data })
  return (
    <button
      type="button"
      ref={setNodeRef}
      className={`template-grip ${isDragging ? 'template-grip--dragging' : ''}`.trim()}
      aria-label={label}
      {...attributes}
      {...listeners}
    >
      <GripVertical size={14} aria-hidden="true" />
    </button>
  )
}

// One template in the side panel: what it is, where it lives, and whether it
// brings a form with it.
function PanelCard({ template, origin }) {
  return (
    <li className="template-card">
      <DragHandle
        id={`${origin}-${template.id}`}
        data={{ origin, template }}
        label={`Drag ${template.label} into a phase`}
      />
      <div className="template-card__body">
        <div className="template-card__label">{template.label}</div>
        <div className="template-card__meta">
          Phase {template.phase}
          {template.form_fields?.length > 0 && <> · {template.form_fields.length}-field form</>}
          {!template.is_active && <> · inactive</>}
        </div>
      </div>
    </li>
  )
}

function LibraryPanel({ templates, isOver }) {
  const [tab, setTab] = useState('inactive')

  const inactive = templates.filter((template) => !template.is_active)
  // The library is the whole catalogue -- including templates already live
  // in a phase, since copying one into a second phase is the point.
  const library = [...templates].sort((a, b) => a.label.localeCompare(b.label))
  const shown = tab === 'inactive' ? inactive : library

  return (
    <aside
      className={`template-panel ${isOver ? 'template-panel--over' : ''}`.trim()}
      aria-label="Template library"
    >
      <div className="template-panel__tabs" role="tablist" aria-label="Template library sections">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'inactive'}
          className={`template-panel__tab ${tab === 'inactive' ? 'template-panel__tab--active' : ''}`.trim()}
          onClick={() => setTab('inactive')}
        >
          Inactive
          <span className="template-panel__count">{inactive.length}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'library'}
          className={`template-panel__tab ${tab === 'library' ? 'template-panel__tab--active' : ''}`.trim()}
          onClick={() => setTab('library')}
        >
          Library
          <span className="template-panel__count">{library.length}</span>
        </button>
      </div>

      <p className="template-panel__hint">
        {tab === 'inactive'
          ? 'Drag one into a phase to bring it back, or drag a live task here to retire it.'
          : 'Drag any of these into a phase to add a copy of it there, form and all.'}
      </p>

      {shown.length === 0 ? (
        <p className="text-body-secondary small mb-0">
          {tab === 'inactive' ? 'Nothing retired.' : 'No templates yet.'}
        </p>
      ) : (
        <ul className="template-panel__list">
          {shown.map((template) => (
            <PanelCard key={`${tab}-${template.id}`} template={template} origin={tab} />
          ))}
        </ul>
      )}
    </aside>
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
      <DragHandle
        id={`active-${template.id}`}
        data={{ origin: 'active', template }}
        label={`Move ${template.label} to another phase or retire it`}
      />
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
      <InputGroup size="sm" style={{ maxWidth: '8rem' }}>
        <Form.Control
          key={`duration-${template.id}-${template.default_duration_days ?? 'null'}`}
          type="number"
          min="0"
          defaultValue={template.default_duration_days ?? ''}
          disabled={busy}
          placeholder="None"
          aria-label={`Default duration in days for ${template.label}`}
          title="Days from that phase's start until this task is due. Leave blank for no deadline."
          onBlur={(event) => {
            const raw = event.target.value.trim()
            const days = raw === '' ? null : Number(raw)
            if (days === (template.default_duration_days ?? null)) return
            onDurationChange(template, days)
          }}
        />
        <InputGroup.Text>days</InputGroup.Text>
      </InputGroup>
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

  const [dragging, setDragging] = useState(null)
  const sensors = useSensors(
    // A few pixels before a drag starts, so clicking the grip doesn't
    // register as a zero-length drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor),
  )

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

  // The phases show live tasks only -- retired ones live in the panel.
  function activeForPhase(phase) {
    return templatesForPhase(phase).filter((template) => template.is_active)
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
    } catch (err) {
      setRowError(errorMessage(err, 'Failed to reorder tasks.'))
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
    } catch (err) {
      setRowError(errorMessage(err, 'Failed to update the task.'))
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
    } catch (err) {
      setRowError(errorMessage(err, 'Failed to update confirmation authority.'))
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
    } catch (err) {
      setRowError(errorMessage(err, 'Failed to update the client-facing flag.'))
    } finally {
      setBusyId(null)
    }
  }

  async function handleDurationChange(template, days) {
    setBusyId(template.id)
    setRowError(null)
    try {
      const updated = await patch(`/api/requirement-templates/${template.id}/`, {
        default_duration_days: days,
      })
      setTemplates((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))
    } catch (err) {
      setRowError(errorMessage(err, 'Failed to update the default duration.'))
    } finally {
      setBusyId(null)
    }
  }

  async function handleEditSave(payload) {
    setEditSaving(true)
    setEditError(null)
    try {
      const updated = await patch(`/api/requirement-templates/${editingTemplate.id}/`, payload)
      setTemplates((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))
      setEditingTemplate(null)
    } catch (err) {
      setEditError(errorMessage(err, 'Failed to save the task.'))
    } finally {
      setEditSaving(false)
    }
  }

  async function handleAddSave(payload) {
    setAddSaving(true)
    setAddError(null)
    try {
      const siblings = templatesForPhase(addPhase)
      const maxOrder = siblings.reduce((max, t) => Math.max(max, t.order), 0)
      const created = await post('/api/requirement-templates/', {
        ...payload,
        phase: addPhase,
        order: maxOrder + 1,
        confirmation_authority: 'REP',
      })
      setTemplates((prev) => [...prev, created])
      setAddPhase(null)
    } catch (err) {
      setAddError(errorMessage(err, 'Failed to create the task.'))
    } finally {
      setAddSaving(false)
    }
  }

  // Dropping decides by where the dragged thing came from: a live task
  // moves or retires, an inactive one comes back, a library one is copied.
  async function handleDragEnd(event) {
    const { active, over } = event
    setDragging(null)
    if (!over) {
      return
    }

    const origin = active.data.current?.origin
    const template = active.data.current?.template
    if (!template) {
      return
    }

    const overId = String(over.id)
    const toPhase = overId.startsWith(PHASE_DROP_PREFIX) ? Number(overId.slice(PHASE_DROP_PREFIX.length)) : null

    setBusyId(template.id)
    setRowError(null)
    try {
      if (toPhase) {
        if (origin === 'library' && template.is_active) {
          // Already live somewhere: put a copy in the target phase rather
          // than moving the original out of the phase it serves.
          if (template.phase === toPhase) {
            setRowError(`"${template.label}" is already in phase ${toPhase}.`)
            return
          }
          const created = await post(`/api/requirement-templates/${template.id}/copy/`, { phase: toPhase })
          setTemplates((prev) => [...prev, created])
          return
        }

        if (origin === 'active' && template.phase === toPhase) {
          return
        }

        const updated = await patch(`/api/requirement-templates/${template.id}/`, {
          is_active: true,
          phase: toPhase,
          order: nextOrderFor(toPhase),
        })
        setTemplates((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))
        return
      }

      if (overId === PANEL_DROP_ID && origin === 'active') {
        const updated = await patch(`/api/requirement-templates/${template.id}/`, { is_active: false })
        setTemplates((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))
      }
    } catch (err) {
      setRowError(errorMessage(err, 'Failed to move that task.'))
    } finally {
      setBusyId(null)
    }
  }

  function nextOrderFor(phase) {
    return templates
      .filter((template) => template.phase === phase)
      .reduce((max, template) => Math.max(max, template.order), 0) + 1
  }

  return (
    <>
      <p className="text-body-secondary small">
        Active tasks are generated onto every new project. Drag one into the panel to retire it, or drag from the
        panel into a phase to bring it back — a task&apos;s form travels with it.
      </p>
      {error && <Alert variant="danger">{error}</Alert>}
      {rowError && (
        <Alert variant="danger" dismissible onClose={() => setRowError(null)}>
          {rowError}
        </Alert>
      )}

      {loading ? (
        <div className="d-flex justify-content-center py-5">
          <Spinner animation="border" role="status">
            <span className="visually-hidden">Loading…</span>
          </Spinner>
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={pointerWithin}
          onDragStart={(event) => setDragging(event.active.data.current?.template ?? null)}
          onDragCancel={() => setDragging(null)}
          onDragEnd={handleDragEnd}
        >
          <div className="templates-layout">
            <div>
              {PHASE_NUMBERS.map((phase) => (
                <PhaseDroppable key={phase} phase={phase} onAdd={setAddPhase}>
                  {activeForPhase(phase).length === 0 ? (
                    <p className="text-body-secondary small mb-0 p-3">
                      Nothing here yet — drag a template in, or add one.
                    </p>
                  ) : (
                    <ListGroup variant="flush">
                      {activeForPhase(phase).map((template, index) => (
                        <TemplateRow
                          key={template.id}
                          template={template}
                          isFirst={index === 0}
                          isLast={index === activeForPhase(phase).length - 1}
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
                </PhaseDroppable>
              ))}
            </div>

            <PanelDroppable templates={templates} />
          </div>

          <DragOverlay>
            {dragging ? <div className="template-drag-preview">{dragging.label}</div> : null}
          </DragOverlay>
        </DndContext>
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

// Thin wrappers so the droppable hooks sit outside the page component.
function PhaseDroppable({ phase, onAdd, children }) {
  const { setNodeRef, isOver } = useDroppable({ id: `${PHASE_DROP_PREFIX}${phase}` })
  return (
    <div ref={setNodeRef}>
      <PhaseDropZone phase={phase} isOver={isOver} onAdd={onAdd}>
        {children}
      </PhaseDropZone>
    </div>
  )
}

function PanelDroppable({ templates }) {
  const { setNodeRef, isOver } = useDroppable({ id: PANEL_DROP_ID })
  return (
    <div ref={setNodeRef}>
      <LibraryPanel templates={templates} isOver={isOver} />
    </div>
  )
}
