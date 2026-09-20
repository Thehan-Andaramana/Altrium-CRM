import { differenceInCalendarDays } from 'date-fns'
import { Check, CheckSquare, Clock, Flame, FolderKanban, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import Alert from 'react-bootstrap/Alert'
import Badge from 'react-bootstrap/Badge'
import Card from 'react-bootstrap/Card'
import Col from 'react-bootstrap/Col'
import ListGroup from 'react-bootstrap/ListGroup'
import Row from 'react-bootstrap/Row'
import Spinner from 'react-bootstrap/Spinner'
import { Link } from 'react-router-dom'
import { errorMessage, get, patch } from '../api'
import { useAuth } from '../AuthContext.jsx'
import { PersonCell } from '../components/Avatar.jsx'
import { usePageMeta } from '../components/PageChrome.jsx'
import StatCard from '../components/StatCard.jsx'

const MANAGEMENT_ROLES = new Set(['SALES_MANAGER', 'EXECUTIVE_MANAGER', 'SYSTEM_ADMIN'])
const LIST_LIMIT = 5

const REQUEST_TYPE_LABELS = {
  ARCHIVE_LEAD: 'Archive Lead',
  LEAD_STATUS_CHANGE: 'Lead Status Change',
  PHASE_1_SIGNOFF: 'Phase 1 Signoff',
  PHASE_2_SIGNOFF: 'Phase 2 Signoff',
  PHASE_3_SIGNOFF: 'Phase 3 Signoff',
  PHASE_4_SIGNOFF: 'Phase 4 Signoff',
}

function LeadListItem({ lead, extra }) {
  return (
    <ListGroup.Item className="d-flex justify-content-between align-items-center gap-2">
      <div>
        <Link to={`/leads/${lead.id}`}>{lead.name}</Link>
        <div className="text-body-secondary small">{lead.company_name ?? '—'}</div>
      </div>
      {extra}
    </ListGroup.Item>
  )
}

function CardHeader({ title, count, accent }) {
  return (
    <Card.Header className="d-flex justify-content-between align-items-center">
      <span>{title}</span>
      <Badge bg={accent ? 'warning' : 'secondary'}>{count}</Badge>
    </Card.Header>
  )
}

function LeadCard({ title, accent, count, items, viewAllHref, emptyMessage }) {
  const visible = items.slice(0, LIST_LIMIT)
  return (
    <Card className="h-100" border={accent ? 'warning' : undefined}>
      <CardHeader title={title} count={count} accent={accent} />
      <Card.Body className="d-flex flex-column p-0">
        {visible.length === 0 ? (
          <p className="text-body-secondary p-3 mb-0">{emptyMessage}</p>
        ) : (
          <ListGroup variant="flush">
            {visible.map((lead) => (
              <LeadListItem key={lead.id} lead={lead} />
            ))}
          </ListGroup>
        )}
        <div className="mt-auto p-3 pt-2">
          <Link to={viewAllHref}>View all</Link>
        </div>
      </Card.Body>
    </Card>
  )
}

function ApproachingColdCard({ count, items, coldLeadDays }) {
  const visible = items.slice(0, LIST_LIMIT)
  return (
    <Card className="h-100">
      <CardHeader title="Approaching Cold" count={count} />
      <Card.Body className="d-flex flex-column p-0">
        {visible.length === 0 ? (
          <p className="text-body-secondary p-3 mb-0">No leads approaching cold.</p>
        ) : (
          <ListGroup variant="flush">
            {visible.map((lead) => {
              const elapsed = differenceInCalendarDays(new Date(), new Date(lead.last_activity_at))
              const daysLeft = coldLeadDays != null ? Math.max(coldLeadDays - elapsed, 0) : null
              return (
                <LeadListItem
                  key={lead.id}
                  lead={lead}
                  extra={
                    daysLeft != null ? (
                      <Badge bg="secondary" pill>
                        {daysLeft} {daysLeft === 1 ? 'day' : 'days'} left
                      </Badge>
                    ) : null
                  }
                />
              )
            })}
          </ListGroup>
        )}
        <div className="mt-auto p-3 pt-2">
          <Link to="/leads?status=HOT">View all</Link>
        </div>
      </Card.Body>
    </Card>
  )
}

function ApprovalsCard({ count, items, userRole, actioningId, actionError, onDecide }) {
  const visible = items.slice(0, LIST_LIMIT)
  const canDecide = MANAGEMENT_ROLES.has(userRole)
  return (
    <Card className="h-100">
      <CardHeader title="Pending Approvals" count={count} />
      <Card.Body className="d-flex flex-column p-0">
        {actionError && (
          <Alert variant="danger" className="m-3 mb-0">
            {actionError}
          </Alert>
        )}
        {visible.length === 0 ? (
          <p className="text-body-secondary p-3 mb-0">No pending approvals.</p>
        ) : (
          <ListGroup variant="flush">
            {visible.map((approval) => {
              // PHASE_4_SIGNOFF (Executive Sign-Off) can only be decided by
              // an EXECUTIVE_MANAGER, not just any management role.
              const canDecideThis =
                canDecide && (approval.request_type !== 'PHASE_4_SIGNOFF' || userRole === 'EXECUTIVE_MANAGER')
              return (
                <ListGroup.Item key={approval.id}>
                  <div className="d-flex justify-content-between align-items-start gap-2">
                    <div>
                      <div>
                        {approval.lead_name ?? '—'}
                        <span className="text-body-secondary"> · {approval.company_name ?? '—'}</span>
                      </div>
                      <div className="text-body-secondary small">
                        {REQUEST_TYPE_LABELS[approval.request_type] ?? approval.request_type}
                        {approval.phase_number ? ` (Phase ${approval.phase_number})` : ''}
                        {approval.request_type === 'LEAD_STATUS_CHANGE' && approval.target_status
                          ? ` → ${approval.target_status}`
                          : ''}
                      </div>
                      <div className="text-body-secondary small d-flex align-items-center gap-1 mt-1">
                        Requested by <PersonCell name={approval.requested_by_username} fallback="Unknown" />
                      </div>
                      {approval.request_type === 'LEAD_STATUS_CHANGE' && approval.reason && (
                        <div className="text-body-secondary small fst-italic">{approval.reason}</div>
                      )}
                    </div>
                    {canDecideThis && (
                      <div className="d-flex gap-1 flex-shrink-0">
                        <button
                          type="button"
                          className="icon-button icon-button--success"
                          disabled={actioningId === approval.id}
                          onClick={() => onDecide(approval, 'APPROVED')}
                          aria-label="Approve"
                          title="Approve"
                        >
                          <Check size={16} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className="icon-button icon-button--danger"
                          disabled={actioningId === approval.id}
                          onClick={() => onDecide(approval, 'REJECTED')}
                          aria-label="Reject"
                          title="Reject"
                        >
                          <X size={16} aria-hidden="true" />
                        </button>
                      </div>
                    )}
                  </div>
                </ListGroup.Item>
              )
            })}
          </ListGroup>
        )}
        <div className="mt-auto p-3 pt-2">
          <Link to="/approvals">View all</Link>
        </div>
      </Card.Body>
    </Card>
  )
}

export default function Home() {
  const { user } = useAuth()

  const [dashboard, setDashboard] = useState(null)
  const [coldLeadDays, setColdLeadDays] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [actioningId, setActioningId] = useState(null)
  const [actionError, setActionError] = useState(null)

  usePageMeta({ title: 'Dashboard' })

  useEffect(() => {
    let cancelled = false

    async function fetchAll() {
      setLoading(true)
      setError(null)
      try {
        const [dashboardData, settingsData] = await Promise.all([get('/api/dashboard/'), get('/api/settings/')])
        if (!cancelled) {
          setDashboard(dashboardData)
          setColdLeadDays(settingsData.cold_lead_days)
        }
      } catch {
        if (!cancelled) setError('Failed to load dashboard.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchAll()
    return () => {
      cancelled = true
    }
  }, [])

  async function refreshDashboard() {
    const data = await get('/api/dashboard/')
    setDashboard(data)
  }

  async function handleDecision(approval, decision) {
    setActioningId(approval.id)
    setActionError(null)
    try {
      await patch(`/api/approvals/${approval.id}/`, { status: decision })
      await refreshDashboard()
    } catch (err) {
      setActionError(errorMessage(err, `Failed to ${decision === 'APPROVED' ? 'approve' : 'reject'} that request.`))
    } finally {
      setActioningId(null)
    }
  }

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
      <Row xs={1} sm={2} xl={4} className="g-3 mb-4">
        <Col>
          <StatCard
            label="Hot Leads"
            value={dashboard.hot_leads.count}
            Icon={Flame}
            tone="amber"
            to="/leads?status=HOT"
          />
        </Col>
        <Col>
          <StatCard
            label="Overdue Tasks"
            value={dashboard.overdue_tasks.count}
            Icon={Clock}
            tone="red"
            to="/calendar"
          />
        </Col>
        <Col>
          <StatCard
            label="Pending Approvals"
            value={dashboard.pending_approvals.count}
            Icon={CheckSquare}
            tone="amber"
            to="/approvals"
          />
        </Col>
        <Col>
          <StatCard
            label="Active Projects"
            value={dashboard.active_projects.count}
            Icon={FolderKanban}
            tone="blue"
            to="/board"
          />
        </Col>
      </Row>

      <Row xs={1} md={2} xl={4} className="g-3">
        <Col>
          <LeadCard
            title="Hot Leads"
            accent
            count={dashboard.hot_leads.count}
            items={dashboard.hot_leads.results}
            viewAllHref="/leads?status=HOT"
            emptyMessage="No hot leads."
          />
        </Col>
        <Col>
          <ApproachingColdCard
            count={dashboard.approaching_cold_leads.count}
            items={dashboard.approaching_cold_leads.results}
            coldLeadDays={coldLeadDays}
          />
        </Col>
        <Col>
          <LeadCard
            title="Cold Leads"
            count={dashboard.cold_leads.count}
            items={dashboard.cold_leads.results}
            viewAllHref="/leads?status=COLD"
            emptyMessage="No cold leads."
          />
        </Col>
        <Col>
          <ApprovalsCard
            count={dashboard.pending_approvals.count}
            items={dashboard.pending_approvals.results}
            userRole={user?.role}
            actioningId={actioningId}
            actionError={actionError}
            onDecide={handleDecision}
          />
        </Col>
      </Row>
    </>
  )
}
