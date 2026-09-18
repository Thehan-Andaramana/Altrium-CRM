import { ChevronLeft, ChevronRight, LayoutGrid, List } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import Alert from 'react-bootstrap/Alert'
import Badge from 'react-bootstrap/Badge'
import Button from 'react-bootstrap/Button'
import ButtonGroup from 'react-bootstrap/ButtonGroup'
import Container from 'react-bootstrap/Container'
import ListGroup from 'react-bootstrap/ListGroup'
import Spinner from 'react-bootstrap/Spinner'
import { useNavigate } from 'react-router-dom'
import { get } from '../api'

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const STATUS_BADGE_VARIANT = {
  OVERDUE: 'danger',
  DUE_SOON: 'warning',
  COMPLETE: 'success',
  UPCOMING: 'secondary',
}

const STATUS_LABELS = {
  OVERDUE: 'Overdue',
  DUE_SOON: 'Due soon',
  COMPLETE: 'Complete',
  UPCOMING: 'Upcoming',
}

const NARROW_SCREEN_BREAKPOINT = 768

// One cell per calendar day, in row-major order, padded with `null` at both
// ends so day 1 lands under the right weekday and the grid always ends on a
// full week -- `month` is 1-12, matching the API's convention.
function buildMonthCells(year, month) {
  const startWeekday = new Date(year, month - 1, 1).getDay()
  const daysInMonth = new Date(year, month, 0).getDate()
  const cells = Array(startWeekday).fill(null)
  for (let day = 1; day <= daysInMonth; day += 1) cells.push(day)
  while (cells.length % 7 !== 0) cells.push(null)
  return cells
}

function isToday(year, month, day) {
  const now = new Date()
  return now.getFullYear() === year && now.getMonth() + 1 === month && now.getDate() === day
}

// `new Date('2026-09-20')` parses as UTC midnight, which .toLocaleDateString
// can then render as the previous day in any timezone behind UTC -- this
// builds a local-midnight Date from the same "YYYY-MM-DD" string instead.
function parseISODate(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export default function Calendar() {
  const navigate = useNavigate()
  const today = new Date()

  const [year, setYear] = useState(today.getFullYear())
  const [month, setMonth] = useState(today.getMonth() + 1)
  const [tasks, setTasks] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  // Manual toggle, defaulted from the viewport width at first render --
  // narrow screens (where a 7-column grid has no room to be useful) start in
  // list view, but either view stays a click away regardless of width.
  const [view, setView] = useState(() => (window.innerWidth < NARROW_SCREEN_BREAKPOINT ? 'list' : 'grid'))

  useEffect(() => {
    let cancelled = false

    async function fetchTasks() {
      setLoading(true)
      setError(null)
      try {
        const data = await get(`/api/calendar/?year=${year}&month=${month}`)
        if (!cancelled) setTasks(data)
      } catch {
        if (!cancelled) setError('Failed to load the calendar.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchTasks()
    return () => {
      cancelled = true
    }
  }, [year, month])

  const tasksByDay = useMemo(() => {
    const map = {}
    for (const task of tasks) {
      const day = Number(task.due_date.slice(-2))
      ;(map[day] ??= []).push(task)
    }
    return map
  }, [tasks])

  const cells = useMemo(() => buildMonthCells(year, month), [year, month])

  function goToPreviousMonth() {
    if (month === 1) {
      setYear((y) => y - 1)
      setMonth(12)
    } else {
      setMonth((m) => m - 1)
    }
  }

  function goToNextMonth() {
    if (month === 12) {
      setYear((y) => y + 1)
      setMonth(1)
    } else {
      setMonth((m) => m + 1)
    }
  }

  function goToToday() {
    setYear(today.getFullYear())
    setMonth(today.getMonth() + 1)
  }

  function openTask(task) {
    navigate(`/leads/${task.lead_id}?tab=phases&task=${task.id}`)
  }

  const monthLabel = new Date(year, month - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })

  return (
    <Container style={{ maxWidth: '64rem' }}>
      <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
        <h1 className="h3 mb-0">Calendar</h1>
        <div className="d-flex flex-wrap align-items-center gap-2">
          <ButtonGroup size="sm">
            <Button variant="outline-secondary" onClick={goToPreviousMonth} aria-label="Previous month">
              <ChevronLeft size={16} />
            </Button>
            <Button variant="outline-secondary" onClick={goToToday}>
              Today
            </Button>
            <Button variant="outline-secondary" onClick={goToNextMonth} aria-label="Next month">
              <ChevronRight size={16} />
            </Button>
          </ButtonGroup>
          <ButtonGroup size="sm">
            <Button
              variant={view === 'grid' ? 'secondary' : 'outline-secondary'}
              onClick={() => setView('grid')}
              aria-label="Grid view"
              title="Grid view"
            >
              <LayoutGrid size={16} />
            </Button>
            <Button
              variant={view === 'list' ? 'secondary' : 'outline-secondary'}
              onClick={() => setView('list')}
              aria-label="List view"
              title="List view"
            >
              <List size={16} />
            </Button>
          </ButtonGroup>
        </div>
      </div>

      <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
        <h2 className="h5 text-body-secondary mb-0">{monthLabel}</h2>
        <div className="d-flex flex-wrap gap-3 small text-body-secondary">
          {Object.entries(STATUS_LABELS).map(([key, label]) => (
            <span key={key} className="d-inline-flex align-items-center gap-1">
              <span
                className={`bg-${STATUS_BADGE_VARIANT[key]} rounded-circle`}
                style={{ width: '0.6rem', height: '0.6rem' }}
                aria-hidden="true"
              />
              {label}
            </span>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="d-flex justify-content-center py-5">
          <Spinner animation="border" role="status">
            <span className="visually-hidden">Loading…</span>
          </Spinner>
        </div>
      ) : error ? (
        <Alert variant="danger">{error}</Alert>
      ) : view === 'grid' ? (
        <div className="calendar-grid">
          {WEEKDAY_LABELS.map((label) => (
            <div key={label} className="text-body-secondary small fw-semibold text-uppercase p-2">
              {label}
            </div>
          ))}
          {cells.map((day, index) => (
            <div key={index} className="calendar-cell">
              {day && (
                <>
                  <div
                    className={
                      isToday(year, month, day)
                        ? 'small mb-1 fw-bold text-primary'
                        : 'small mb-1 text-body-secondary'
                    }
                  >
                    {day}
                  </div>
                  <div className="d-flex flex-column gap-1">
                    {(tasksByDay[day] ?? []).map((task) => (
                      <Button
                        key={task.id}
                        variant={`outline-${STATUS_BADGE_VARIANT[task.calendar_status]}`}
                        size="sm"
                        className="calendar-entry py-0 px-1"
                        onClick={() => openTask(task)}
                        title={`${task.label} — ${task.lead_name} (Phase ${task.phase})`}
                      >
                        <div className="text-truncate small fw-semibold">{task.label}</div>
                        <div className="text-truncate" style={{ fontSize: '0.7rem' }}>
                          {task.lead_name} · Phase {task.phase}
                        </div>
                      </Button>
                    ))}
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      ) : tasks.length === 0 ? (
        <p className="text-body-secondary">No tasks due this month.</p>
      ) : (
        <ListGroup>
          {tasks.map((task) => (
            <ListGroup.Item
              key={task.id}
              action
              onClick={() => openTask(task)}
              className="d-flex justify-content-between align-items-center gap-2"
            >
              <div>
                <div className="fw-semibold">{task.label}</div>
                <div className="text-body-secondary small">
                  {task.lead_name} · Phase {task.phase} ·{' '}
                  {parseISODate(task.due_date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                </div>
              </div>
              <Badge bg={STATUS_BADGE_VARIANT[task.calendar_status]}>{STATUS_LABELS[task.calendar_status]}</Badge>
            </ListGroup.Item>
          ))}
        </ListGroup>
      )}
    </Container>
  )
}
