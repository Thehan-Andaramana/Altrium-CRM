import { differenceInCalendarDays } from 'date-fns'
import { useEffect, useState } from 'react'
import Alert from 'react-bootstrap/Alert'
import Badge from 'react-bootstrap/Badge'
import Button from 'react-bootstrap/Button'
import Card from 'react-bootstrap/Card'
import Col from 'react-bootstrap/Col'
import ListGroup from 'react-bootstrap/ListGroup'
import Row from 'react-bootstrap/Row'
import Spinner from 'react-bootstrap/Spinner'
import { Link } from 'react-router-dom'
import { get, patch } from '../api'
import { useAuth } from '../AuthContext.jsx'

const MANAGEMENT_ROLES = new Set(['SALES_MANAGER', 'EXECUTIVE_MANAGER', 'SYSTEM_ADMIN'])
const LIST_LIMIT = 5

const REQUEST_TYPE_LABELS = {
  ARCHIVE_LEAD: 'Archive Lead',
  PHASE_1_SIGNOFF: 'Phase 1 Signoff',
  PHASE_2_SIGNOFF: 'Phase 2 Signoff',
  PHASE_3_SIGNOFF: 'Phase 3 Signoff',
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

function ApprovalsCard({ count, items, canDecide, actioningId, actionError, onDecide }) {
  const visible = items.slice(0, LIST_LIMIT)
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
            {visible.map((approval) => (
              <ListGroup.Item key={approval.id}>
                <div className="d-flex justify-content-between align-items-start gap-2">
                  <div>
                    <div>
                      {approval.lead_name ?? '—'}
                      <span className="text-body-secondary"> · {approval.company_name ?? '—'}</span>
                    </div>
                    <div className="text-body-secondary small">
                      {REQUEST_TYPE_LABELS[approval.request_type] ?? approval.request_type}
                      {approval.phase_number ? ` (Phase ${approval.phase_number})` : ''} · Requested by{' '}
                      {approval.requested_by_username ?? 'Unknown'}
                    </div>
                  </div>
                  {canDecide && (
                    <div className="d-flex gap-1 flex-shrink-0">
                      <Button
                        size="sm"
                        variant="outline-success"
                        disabled={actioningId === approval.id}
                        onClick={() => onDecide(approval, 'APPROVED')}
                      >
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline-danger"
                        disabled={actioningId === approval.id}
                        onClick={() => onDecide(approval, 'REJECTED')}
                      >
                        Reject
                      </Button>
                    </div>
                  )}
                </div>
              </ListGroup.Item>
            ))}
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
  const canDecide = MANAGEMENT_ROLES.has(user?.role)

  const [dashboard, setDashboard] = useState(null)
  const [coldLeadDays, setColdLeadDays] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [actioningId, setActioningId] = useState(null)
  const [actionError, setActionError] = useState(null)

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
    } catch {
      setActionError(`Failed to ${decision === 'APPROVED' ? 'approve' : 'reject'} that request.`)
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
      <h1 className="h3 mb-3">Dashboard</h1>
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
            canDecide={canDecide}
            actioningId={actioningId}
            actionError={actionError}
            onDecide={handleDecision}
          />
        </Col>
      </Row>
    </>
  )
}
