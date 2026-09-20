import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { AlertTriangle, GripVertical, Info, Plus, Wallet } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Alert from 'react-bootstrap/Alert'
import Form from 'react-bootstrap/Form'
import Spinner from 'react-bootstrap/Spinner'
import { useNavigate } from 'react-router-dom'
import { errorMessage, get, post } from '../api'
import { useAuth } from '../AuthContext.jsx'
import Avatar, { AvatarStack } from '../components/Avatar.jsx'
import { usePageMeta } from '../components/PageChrome.jsx'
import { LeadStatusBadge } from '../components/StatusPill.jsx'

// A column is a phase, plus one terminal column for work that has finished
// all four. `match` decides which column a project belongs in -- never the
// board, and never a drag (see handleDragEnd).
const COLUMNS = [
  { key: 'phase-1', title: 'Phase 1 Requirements', tone: 'blue', match: (p) => !p.maintenance && p.current_phase === 1 },
  { key: 'phase-2', title: 'Phase 2 Analysis', tone: 'blue', match: (p) => !p.maintenance && p.current_phase === 2 },
  { key: 'phase-3', title: 'Phase 3 Execution', tone: 'amber', match: (p) => !p.maintenance && p.current_phase === 3 },
  { key: 'phase-4', title: 'Phase 4 Sign-Off', tone: 'amber', match: (p) => !p.maintenance && p.current_phase === 4 },
  { key: 'complete', title: 'Completed / Maintenance', tone: 'green', match: (p) => p.maintenance },
]

const CROSS_COLUMN_MESSAGE =
  'Phases advance through approval, not by dragging. Complete the phase’s tasks and request sign-off.'

// How long the cross-column explanation stays up after a rejected drag.
const TOOLTIP_MS = 5000

function columnFor(project) {
  return COLUMNS.find((column) => column.match(project)) ?? COLUMNS[0]
}

// Columns are droppable in their own right, not just the cards in them --
// otherwise dragging onto an empty column reports no drop target at all and
// the card would just spring back with nothing said. Prefixed so a column
// id can never collide with a card's (a project id).
const COLUMN_DROPPABLE_PREFIX = 'column:'

function columnKeyFromDropTarget(overId, projects) {
  if (typeof overId === 'string' && overId.startsWith(COLUMN_DROPPABLE_PREFIX)) {
    return overId.slice(COLUMN_DROPPABLE_PREFIX.length)
  }
  const project = projects.find((candidate) => candidate.id === overId)
  return project ? columnFor(project).key : null
}

function isColumnId(id) {
  return typeof id === 'string' && id.startsWith(COLUMN_DROPPABLE_PREFIX)
}

// Cards and columns are both droppable, and they overlap by definition --
// every card sits inside a column. Resolving by nearest centre alone lets
// the column win over the card the pointer is actually on (so a reorder
// reads as a drop on empty space), and lets a *distant* card win when the
// pointer is over an empty column (so a refused cross-column drag reads as
// a reorder). Taking what is under the pointer first, and preferring the
// card among those, gets both right; the column is the fallback, which is
// exactly the empty-column case.
function collisionDetection(args) {
  const underPointer = pointerWithin(args)
  const card = underPointer.find((collision) => !isColumnId(collision.id))
  if (card) {
    return [card]
  }
  if (underPointer.length > 0) {
    return underPointer
  }
  return closestCenter({
    ...args,
    droppableContainers: args.droppableContainers.filter((container) => isColumnId(container.id)),
  })
}

function formatBudget(project) {
  if (project.proposed_budget == null) {
    return null
  }
  const amount = Number(project.proposed_budget)
  const formatted = Number.isFinite(amount) ? amount.toLocaleString() : project.proposed_budget
  return project.currency ? `${project.currency} ${formatted}` : formatted
}

function BoardCard({ project, onOpen, dragHandleProps, isDragging }) {
  const progress = project.phase_progress?.[project.current_phase]?.percent ?? 0
  const budget = formatBudget(project)

  return (
    <article className={`board-card ${isDragging ? 'board-card--dragging' : ''}`.trim()}>
      <div className="d-flex align-items-start gap-2">
        {/* The handle, not the whole card, starts a drag -- otherwise a
            click-through to the lead and a drag are the same gesture. */}
        <button
          type="button"
          className="board-card__handle"
          aria-label={`Reorder ${project.lead_name ?? 'project'}`}
          {...dragHandleProps}
        >
          <GripVertical size={14} aria-hidden="true" />
        </button>
        <button type="button" className="board-card__title" onClick={() => onOpen(project)}>
          {project.lead_name ?? `Project #${project.id}`}
        </button>
        <LeadStatusBadge status={project.lead_status} />
      </div>

      <div className="board-card__company">
        <Avatar name={project.company_name} size="sm" />
        <span className="text-truncate">{project.company_name ?? '—'}</span>
      </div>

      <div>
        <div className="board-card__progress" role="presentation">
          <span style={{ width: `${progress}%` }} />
        </div>
        <div className="board-card__meta">
          <span>
            Phase {project.current_phase} · {progress}%
          </span>
          {/* Rep then PM, each coloured by role and named on hover -- two
              amber discs would say nothing about which is which. */}
          <AvatarStack
            people={[
              project.assigned_to_username && {
                name: project.assigned_to_username,
                title: `${project.assigned_to_username} · Assigned rep`,
              },
              project.project_manager_username && {
                name: project.project_manager_username,
                title: `${project.project_manager_username} · Project manager`,
              },
            ]}
          />
        </div>
      </div>

      {(project.overdue_task_count > 0 || budget) && (
        <div className="board-card__meta">
          {project.overdue_task_count > 0 && (
            <span className="board-card__overdue">
              <AlertTriangle size={13} aria-hidden="true" />
              {project.overdue_task_count} overdue
            </span>
          )}
          {budget && (
            <span className="board-card__budget">
              <Wallet size={13} aria-hidden="true" />
              {budget}
            </span>
          )}
        </div>
      )}
    </article>
  )
}

function SortableCard({ project, onOpen }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: project.id,
    data: { columnKey: columnFor(project).key },
  })

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 }}
    >
      <BoardCard project={project} onOpen={onOpen} dragHandleProps={{ ...attributes, ...listeners }} />
    </div>
  )
}

function Column({ column, projects, onOpen, onAdd }) {
  const { setNodeRef, isOver } = useDroppable({ id: `${COLUMN_DROPPABLE_PREFIX}${column.key}` })

  return (
    <section
      className={`board-column ${isOver ? 'board-column--over' : ''}`.trim()}
      aria-label={column.title}
    >
      <header className="board-column__header">
        <span className={`board-column__dot board-column__dot--${column.tone}`} aria-hidden="true" />
        <h2 className="board-column__title">{column.title}</h2>
        <span className="board-column__count">{projects.length}</span>
        {/* Only Phase 1 can gain a card by being added to -- every other
            column is entered by finishing the phase before it. The + is
            still offered on those, and explains that when used. */}
        <button
          type="button"
          className="board-column__add"
          onClick={() => onAdd(column)}
          aria-label={`Add to ${column.title}`}
          title={column.key === 'phase-1' ? 'New lead' : 'Phases advance through approval'}
        >
          <Plus size={16} aria-hidden="true" />
        </button>
      </header>
      <div className="board-column__body" ref={setNodeRef}>
        <SortableContext
          items={projects.map((project) => project.id)}
          strategy={verticalListSortingStrategy}
        >
          {projects.length === 0 ? (
            <p className="text-body-secondary small mb-0 px-1">Nothing here.</p>
          ) : (
            projects.map((project) => <SortableCard key={project.id} project={project} onOpen={onOpen} />)
          )}
        </SortableContext>
      </div>
    </section>
  )
}

export default function Board() {
  const { user } = useAuth()
  const navigate = useNavigate()

  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [saveError, setSaveError] = useState(null)
  const [blockedMessage, setBlockedMessage] = useState(null)
  const [activeId, setActiveId] = useState(null)

  const [repFilter, setRepFilter] = useState('')
  const [pmFilter, setPmFilter] = useState('')
  const [temperatureFilter, setTemperatureFilter] = useState('')

  const blockedTimeout = useRef(null)

  usePageMeta({ title: 'Board' })

  const sensors = useSensors(
    // A small distance threshold, so a click on the handle isn't read as a
    // drag of zero pixels.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  useEffect(() => {
    let cancelled = false

    async function fetchProjects() {
      setLoading(true)
      setError(null)
      try {
        // Already role-scoped server-side (ProjectViewSet.get_queryset): a
        // rep gets projects for companies they own or leads they're
        // assigned, a PM gets the ones they manage, management gets all --
        // exactly the board's scoping rule, so nothing is filtered by role
        // here.
        const data = await get('/api/projects/?ordering=board_order,-created_at')
        if (!cancelled) setProjects(data)
      } catch {
        if (!cancelled) setError('Failed to load the board.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchProjects()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => () => clearTimeout(blockedTimeout.current), [])

  const reps = useMemo(
    () => [...new Set(projects.map((p) => p.assigned_to_username).filter(Boolean))].sort(),
    [projects],
  )
  const projectManagers = useMemo(
    () => [...new Set(projects.map((p) => p.project_manager_username).filter(Boolean))].sort(),
    [projects],
  )

  // Filtering is a view over what the server already returned -- no refetch,
  // and no way for a filter to widen what this user can see.
  const visibleProjects = useMemo(
    () =>
      projects.filter(
        (project) =>
          (!repFilter || project.assigned_to_username === repFilter) &&
          (!pmFilter || project.project_manager_username === pmFilter) &&
          (!temperatureFilter || project.lead_status === temperatureFilter),
      ),
    [projects, repFilter, pmFilter, temperatureFilter],
  )

  const byColumn = useMemo(() => {
    const grouped = new Map(COLUMNS.map((column) => [column.key, []]))
    for (const project of visibleProjects) {
      grouped.get(columnFor(project).key).push(project)
    }
    return grouped
  }, [visibleProjects])

  const showBlocked = useCallback((message) => {
    setBlockedMessage(message)
    clearTimeout(blockedTimeout.current)
    blockedTimeout.current = setTimeout(() => setBlockedMessage(null), TOOLTIP_MS)
  }, [])

  function openLead(project) {
    navigate(`/leads/${project.lead}`)
  }

  function handleAdd(column) {
    // A project only exists because a lead does, and it only enters a later
    // phase by finishing the one before -- so the only column a card can be
    // added to is the first, and that means creating a lead.
    if (column.key === 'phase-1') {
      navigate('/leads')
      return
    }
    showBlocked(CROSS_COLUMN_MESSAGE)
  }

  async function persistOrder(ordered) {
    // The whole column's new order in one request. Renumbering positionally
    // means every card behind the moved one shifts too, which as one PATCH
    // each would be a request per card -- and the endpoint re-checks that
    // the ids all sit in the same phase, so the board's rule is enforced
    // server-side rather than only here.
    setSaveError(null)
    try {
      await post('/api/projects/reorder/', { order: ordered.map((project) => project.id) })
    } catch (err) {
      setSaveError(errorMessage(err, 'Failed to save the new order.'))
    }
  }

  function handleDragEnd(event) {
    const { active, over } = event
    setActiveId(null)
    if (!over || active.id === over.id) {
      return
    }

    const activeProject = projects.find((project) => project.id === active.id)
    if (!activeProject) {
      return
    }

    // The rule this board exists to respect: a phase moves only through an
    // approved sign-off, so a card cannot be dragged out of its column. The
    // server would refuse the phase change anyway (ProjectSerializer.update
    // requires an approved signoff request) -- this is the UI half of the
    // same rule, and it says why rather than just snapping back.
    const from = columnFor(activeProject)
    const toKey = columnKeyFromDropTarget(over.id, projects)
    if (toKey && toKey !== from.key) {
      showBlocked(CROSS_COLUMN_MESSAGE)
      return
    }

    // Dropped on its own column's empty space rather than on another card:
    // nothing to reorder against.
    const overProject = projects.find((project) => project.id === over.id)
    if (!overProject) {
      return
    }

    // Positions are computed over the column's *whole* contents, not just
    // the cards a filter happens to be showing -- otherwise reordering a
    // filtered view would renumber around the hidden cards and shuffle them.
    const columnProjects = projects.filter((project) => columnFor(project).key === from.key)
    const oldIndex = columnProjects.findIndex((project) => project.id === active.id)
    const newIndex = columnProjects.findIndex((project) => project.id === over.id)
    const reordered = arrayMove(columnProjects, oldIndex, newIndex)

    // Optimistic: the reordered column's new board_order values are applied
    // locally, then persisted. A failed save surfaces above the board and
    // the next load reverts it.
    const orderById = new Map(reordered.map((project, index) => [project.id, index]))
    setProjects((previous) =>
      previous
        .map((project) =>
          orderById.has(project.id) ? { ...project, board_order: orderById.get(project.id) } : project,
        )
        .sort((a, b) => a.board_order - b.board_order || new Date(b.created_at) - new Date(a.created_at)),
    )
    persistOrder(reordered)
  }

  const activeProject = activeId ? projects.find((project) => project.id === activeId) : null

  if (loading) {
    return (
      <div className="d-flex justify-content-center py-5">
        <Spinner animation="border" role="status">
          <span className="visually-hidden">Loading…</span>
        </Spinner>
      </div>
    )
  }

  if (error) {
    return <Alert variant="danger">{error}</Alert>
  }

  return (
    <>
      <div className="d-flex flex-wrap align-items-center gap-2 mb-3">
        <Form.Select
          value={repFilter}
          onChange={(event) => setRepFilter(event.target.value)}
          style={{ maxWidth: '12rem' }}
          aria-label="Filter by assigned rep"
        >
          <option value="">All reps</option>
          {reps.map((rep) => (
            <option key={rep} value={rep}>
              {rep}
            </option>
          ))}
        </Form.Select>
        <Form.Select
          value={pmFilter}
          onChange={(event) => setPmFilter(event.target.value)}
          style={{ maxWidth: '14rem' }}
          aria-label="Filter by project manager"
        >
          <option value="">All project managers</option>
          {projectManagers.map((pm) => (
            <option key={pm} value={pm}>
              {pm}
            </option>
          ))}
        </Form.Select>
        <Form.Select
          value={temperatureFilter}
          onChange={(event) => setTemperatureFilter(event.target.value)}
          style={{ maxWidth: '10rem' }}
          aria-label="Filter by status"
        >
          <option value="">All statuses</option>
          <option value="HOT">Hot</option>
          <option value="COLD">Cold</option>
        </Form.Select>
        <span className="text-body-secondary small ms-auto">
          {visibleProjects.length} {visibleProjects.length === 1 ? 'project' : 'projects'}
          {user?.role === 'SALES_REP' && ' assigned to you'}
        </span>
      </div>

      {saveError && (
        <Alert variant="danger" dismissible onClose={() => setSaveError(null)}>
          {saveError}
        </Alert>
      )}

      {/* role="status" so the explanation is announced when a drag is
          refused, not just drawn. Named, because dnd-kit keeps a live
          region of its own and two unnamed status roles are ambiguous to
          both assistive tech and a test locator. */}
      {blockedMessage && (
        <div className="board-tooltip" role="status" aria-label="Board notice">
          <Info size={16} aria-hidden="true" />
          {blockedMessage}
        </div>
      )}

      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        onDragStart={(event) => setActiveId(event.active.id)}
        onDragCancel={() => setActiveId(null)}
        onDragEnd={handleDragEnd}
      >
        <div className="board">
          {COLUMNS.map((column) => (
            <Column
              key={column.key}
              column={column}
              projects={byColumn.get(column.key)}
              onOpen={openLead}
              onAdd={handleAdd}
            />
          ))}
        </div>
        <DragOverlay>
          {activeProject ? (
            <BoardCard project={activeProject} onOpen={() => {}} dragHandleProps={{}} isDragging />
          ) : null}
        </DragOverlay>
      </DndContext>
    </>
  )
}
