import { format, subDays } from 'date-fns'
import { CheckSquare, Clock, Download, FolderKanban, Wallet } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import Alert from 'react-bootstrap/Alert'
import Button from 'react-bootstrap/Button'
import Card from 'react-bootstrap/Card'
import Col from 'react-bootstrap/Col'
import Form from 'react-bootstrap/Form'
import Row from 'react-bootstrap/Row'
import Spinner from 'react-bootstrap/Spinner'
import Table from 'react-bootstrap/Table'
import { Navigate } from 'react-router-dom'
import { get } from '../api'
import { useAuth } from '../AuthContext.jsx'
import { PersonCell } from '../components/Avatar.jsx'
import BarChart from '../components/charts/BarChart.jsx'
import Funnel from '../components/charts/Funnel.jsx'
import { usePageMeta } from '../components/PageChrome.jsx'
import { SortableTh, useSortedRows } from '../components/SortableTable.jsx'
import StatCard from '../components/StatCard.jsx'

// Matches ReportingPermission on the backend -- the report aggregates across
// every rep and PM, which is only these three roles' view of the world.
const ALLOWED_ROLES = new Set(['SALES_MANAGER', 'EXECUTIVE_MANAGER', 'SYSTEM_ADMIN'])

const DEFAULT_RANGE_DAYS = 30
const ISO = 'yyyy-MM-dd'

const OUTCOME_LABELS = {
  RESPONDED: 'Responded',
  NO_ANSWER: 'No Answer',
  MISSED_CALL: 'Missed Call',
  LEFT_MESSAGE: 'Left Message',
  BOUNCED: 'Bounced',
  UNSPECIFIED: 'Unspecified',
}

const REP_SORT_ACCESSORS = {
  username: (row) => row.username,
  leads_owned: (row) => row.leads_owned,
  tasks_completed: (row) => row.tasks_completed,
  tasks_overdue: (row) => row.tasks_overdue,
  average_days_to_complete_task: (row) => row.average_days_to_complete_task,
  phase_1_signoffs_approved: (row) => row.phase_1_signoffs_approved,
  phase_1_signoffs_rejected: (row) => row.phase_1_signoffs_rejected,
}

const PM_SORT_ACCESSORS = {
  username: (row) => row.username,
  projects_managed: (row) => row.projects_managed,
  phase_2_tasks_completed: (row) => row.phase_2_tasks_completed,
  phase_3_tasks_completed: (row) => row.phase_3_tasks_completed,
  average_execution_days: (row) => row.average_execution_days,
}

function dash(value) {
  return value == null ? '—' : value
}

function money(value) {
  if (value == null) return '—'
  const amount = Number(value)
  return Number.isFinite(amount) ? amount.toLocaleString(undefined, { maximumFractionDigits: 0 }) : value
}

// CSV of every table on the page, in one file. Quoted per RFC 4180 (double
// any quote, wrap anything containing a comma, quote or newline) so a value
// like a username with a comma in it can't shift the columns.
function toCsvValue(value) {
  const text = value == null ? '' : String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function buildCsv(report) {
  const lines = []
  const section = (title, header, rows) => {
    lines.push(toCsvValue(title))
    lines.push(header.map(toCsvValue).join(','))
    rows.forEach((row) => lines.push(row.map(toCsvValue).join(',')))
    lines.push('')
  }

  lines.push(`Altrium CRM report,${report.range.start} to ${report.range.end}`)
  lines.push('')

  section(
    'Projects per phase (projects created in range)',
    ['Phase', 'Projects'],
    [
      ...report.projects_per_phase.phases.map((entry) => [`Phase ${entry.phase}`, entry.count]),
      ['Maintenance', report.projects_per_phase.maintenance],
      ['Total', report.projects_per_phase.total],
    ],
  )

  section(
    'Average days per phase (phases completed in range)',
    ['Phase', 'Average days', 'Phases completed'],
    report.average_days_per_phase.map((entry) => [`Phase ${entry.phase}`, entry.average_days, entry.completed]),
  )

  section(
    'Per sales rep',
    [
      'Rep', 'Leads owned', 'Tasks completed', 'Tasks overdue (today)',
      'Avg days to complete a task', 'Phase 1 sign-offs approved', 'Phase 1 sign-offs rejected',
    ],
    report.per_rep.map((row) => [
      row.username, row.leads_owned, row.tasks_completed, row.tasks_overdue,
      row.average_days_to_complete_task, row.phase_1_signoffs_approved, row.phase_1_signoffs_rejected,
    ]),
  )

  section(
    'Per project manager',
    ['Project manager', 'Projects managed', 'Phase 2 tasks completed', 'Phase 3 tasks completed', 'Avg execution days'],
    report.per_project_manager.map((row) => [
      row.username, row.projects_managed, row.phase_2_tasks_completed,
      row.phase_3_tasks_completed, row.average_execution_days,
    ]),
  )

  section(
    'Approval throughput',
    ['Raised', 'Approved', 'Rejected', 'Avg days to decision'],
    [[
      report.approval_throughput.raised,
      report.approval_throughput.approved,
      report.approval_throughput.rejected,
      report.approval_throughput.average_days_to_decision,
    ]],
  )

  section(
    'Projects reaching Phase 3',
    ['Projects', 'Total proposed budget', 'Average proposed budget'],
    [[
      report.phase_3_budget.projects,
      report.phase_3_budget.total_proposed_budget,
      report.phase_3_budget.average_proposed_budget,
    ]],
  )

  section(
    'Interaction volume by outcome',
    ['Outcome', 'Interactions'],
    report.interaction_volume.map((row) => [OUTCOME_LABELS[row.outcome] ?? row.outcome, row.count]),
  )

  return lines.join('\n')
}

function downloadCsv(report) {
  const blob = new Blob([buildCsv(report)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `altrium-report-${report.range.start}-to-${report.range.end}.csv`
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

function ChartCard({ title, note, children }) {
  return (
    <Card className="h-100">
      <Card.Body>
        <h2 className="h6 mb-1">{title}</h2>
        {note && <p className="text-body-secondary small mb-3">{note}</p>}
        {children}
      </Card.Body>
    </Card>
  )
}

function RepTable({ rows }) {
  const { rows: sorted, sort, toggle } = useSortedRows(rows, REP_SORT_ACCESSORS)
  return (
    <Table responsive className="table-cards">
      <thead>
        <tr>
          <SortableTh columnKey="username" label="Rep" sort={sort} onToggle={toggle} />
          <SortableTh columnKey="leads_owned" label="Leads owned" sort={sort} onToggle={toggle} />
          <SortableTh columnKey="tasks_completed" label="Tasks completed" sort={sort} onToggle={toggle} />
          <SortableTh columnKey="tasks_overdue" label="Overdue today" sort={sort} onToggle={toggle} />
          <SortableTh
            columnKey="average_days_to_complete_task"
            label="Avg days / task"
            sort={sort}
            onToggle={toggle}
          />
          <SortableTh columnKey="phase_1_signoffs_approved" label="P1 approved" sort={sort} onToggle={toggle} />
          <SortableTh columnKey="phase_1_signoffs_rejected" label="P1 rejected" sort={sort} onToggle={toggle} />
        </tr>
      </thead>
      <tbody>
        {sorted.map((row) => (
          <tr key={row.user_id}>
            <td>
              <PersonCell name={row.username} />
            </td>
            <td>{row.leads_owned}</td>
            <td>{row.tasks_completed}</td>
            <td>{row.tasks_overdue}</td>
            <td>{dash(row.average_days_to_complete_task)}</td>
            <td>{row.phase_1_signoffs_approved}</td>
            <td>{row.phase_1_signoffs_rejected}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  )
}

function ProjectManagerTable({ rows }) {
  const { rows: sorted, sort, toggle } = useSortedRows(rows, PM_SORT_ACCESSORS)
  return (
    <Table responsive className="table-cards">
      <thead>
        <tr>
          <SortableTh columnKey="username" label="Project manager" sort={sort} onToggle={toggle} />
          <SortableTh columnKey="projects_managed" label="Projects managed" sort={sort} onToggle={toggle} />
          <SortableTh columnKey="phase_2_tasks_completed" label="P2 tasks done" sort={sort} onToggle={toggle} />
          <SortableTh columnKey="phase_3_tasks_completed" label="P3 tasks done" sort={sort} onToggle={toggle} />
          <SortableTh columnKey="average_execution_days" label="Avg execution days" sort={sort} onToggle={toggle} />
        </tr>
      </thead>
      <tbody>
        {sorted.map((row) => (
          <tr key={row.user_id}>
            <td>
              <PersonCell name={row.username} />
            </td>
            <td>{row.projects_managed}</td>
            <td>{row.phase_2_tasks_completed}</td>
            <td>{row.phase_3_tasks_completed}</td>
            <td>{dash(row.average_execution_days)}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  )
}

export default function Reports() {
  const { user } = useAuth()
  const allowed = ALLOWED_ROLES.has(user?.role)

  const [start, setStart] = useState(() => format(subDays(new Date(), DEFAULT_RANGE_DAYS - 1), ISO))
  const [end, setEnd] = useState(() => format(new Date(), ISO))
  const [report, setReport] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  usePageMeta({ title: 'Reports' })

  useEffect(() => {
    if (!allowed) {
      return undefined
    }
    let cancelled = false

    async function fetchReport() {
      setLoading(true)
      setError(null)
      try {
        const data = await get(`/api/reports/?start=${start}&end=${end}`)
        if (!cancelled) setReport(data)
      } catch {
        if (!cancelled) setError('Failed to load the report.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchReport()
    return () => {
      cancelled = true
    }
  }, [allowed, start, end])

  const funnelStages = useMemo(() => {
    if (!report) return []
    return [
      ...report.projects_per_phase.phases.map((entry) => ({
        label: `Phase ${entry.phase}`,
        count: entry.count,
      })),
      { label: 'Maintenance', count: report.projects_per_phase.maintenance },
    ]
  }, [report])

  if (!allowed) {
    return <Navigate to="/" replace />
  }

  return (
    <>
      <div className="d-flex flex-wrap align-items-end gap-2 mb-3">
        <Form.Group controlId="report-start">
          <Form.Label className="small text-body-secondary mb-1">From date</Form.Label>
          <Form.Control
            type="date"
            value={start}
            max={end}
            onChange={(event) => setStart(event.target.value)}
          />
        </Form.Group>
        <Form.Group controlId="report-end">
          <Form.Label className="small text-body-secondary mb-1">To date</Form.Label>
          <Form.Control
            type="date"
            value={end}
            min={start}
            onChange={(event) => setEnd(event.target.value)}
          />
        </Form.Group>
        <Button
          variant="outline-secondary"
          className="ms-auto d-inline-flex align-items-center gap-2"
          disabled={!report}
          onClick={() => downloadCsv(report)}
        >
          <Download size={16} aria-hidden="true" />
          Export CSV
        </Button>
      </div>

      {error && <Alert variant="danger">{error}</Alert>}

      {loading || !report ? (
        <div className="d-flex justify-content-center py-5">
          <Spinner animation="border" role="status">
            <span className="visually-hidden">Loading…</span>
          </Spinner>
        </div>
      ) : (
        <>
          <Row xs={1} sm={2} xl={4} className="g-3 mb-4">
            <Col>
              <StatCard
                label="Projects started"
                value={report.projects_per_phase.total}
                Icon={FolderKanban}
                tone="blue"
              />
            </Col>
            <Col>
              <StatCard
                label="Approvals raised"
                value={report.approval_throughput.raised}
                Icon={CheckSquare}
                tone="amber"
              />
            </Col>
            <Col>
              <StatCard
                label="Avg days to a decision"
                value={dash(report.approval_throughput.average_days_to_decision)}
                Icon={Clock}
                tone="grey"
              />
            </Col>
            <Col>
              <StatCard
                label="Budget reaching Phase 3"
                value={money(report.phase_3_budget.total_proposed_budget)}
                Icon={Wallet}
                tone="amber"
              />
            </Col>
          </Row>

          <Row xs={1} lg={2} className="g-3 mb-4">
            <Col>
              <ChartCard
                title="Projects per phase"
                note="Where projects created in this range stand today."
              >
                <Funnel stages={funnelStages} caption="Projects per phase" />
              </ChartCard>
            </Col>
            <Col>
              <ChartCard
                title="Average days per phase"
                note="Phases whose sign-off was approved in this range."
              >
                <BarChart
                  bars={report.average_days_per_phase.map((entry) => ({
                    label: `Phase ${entry.phase}`,
                    value: entry.average_days,
                  }))}
                  caption="Average days per phase"
                  valueSuffix=" days"
                  emptyMessage="No phases were completed in this range."
                />
              </ChartCard>
            </Col>
          </Row>

          <Row xs={1} lg={2} className="g-3 mb-4">
            <Col>
              <ChartCard title="Interaction volume" note="Client contact logged in this range, by outcome.">
                <BarChart
                  bars={report.interaction_volume.map((row) => ({
                    label: OUTCOME_LABELS[row.outcome] ?? row.outcome,
                    value: row.count,
                  }))}
                  caption="Interaction volume by outcome"
                  emptyMessage="No interactions were logged in this range."
                />
              </ChartCard>
            </Col>
            <Col>
              <ChartCard title="Approval throughput" note="Requests decided in this range.">
                <dl className="row mb-0">
                  <dt className="col-7 fw-normal text-body-secondary">Raised</dt>
                  <dd className="col-5 text-end mb-2">{report.approval_throughput.raised}</dd>
                  <dt className="col-7 fw-normal text-body-secondary">Approved</dt>
                  <dd className="col-5 text-end mb-2">{report.approval_throughput.approved}</dd>
                  <dt className="col-7 fw-normal text-body-secondary">Rejected</dt>
                  <dd className="col-5 text-end mb-2">{report.approval_throughput.rejected}</dd>
                  <dt className="col-7 fw-normal text-body-secondary">Average days to decision</dt>
                  <dd className="col-5 text-end mb-2">
                    {dash(report.approval_throughput.average_days_to_decision)}
                  </dd>
                  <dt className="col-7 fw-normal text-body-secondary">Projects reaching Phase 3</dt>
                  <dd className="col-5 text-end mb-2">{report.phase_3_budget.projects}</dd>
                  <dt className="col-7 fw-normal text-body-secondary">Average proposed budget</dt>
                  <dd className="col-5 text-end mb-0">
                    {money(report.phase_3_budget.average_proposed_budget)}
                  </dd>
                </dl>
              </ChartCard>
            </Col>
          </Row>

          <h2 className="h6 mb-2">Per sales rep</h2>
          <p className="text-body-secondary small">
            Tasks completed and sign-offs cover the selected range; leads owned and overdue tasks are current.
          </p>
          <RepTable rows={report.per_rep} />

          <h2 className="h6 mb-2 mt-4">Per project manager</h2>
          <p className="text-body-secondary small">
            Tasks completed and execution durations cover the selected range; projects managed counts those
            started in it.
          </p>
          <ProjectManagerTable rows={report.per_project_manager} />
        </>
      )}
    </>
  )
}
