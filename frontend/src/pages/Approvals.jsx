import { useEffect, useState } from 'react'
import Alert from 'react-bootstrap/Alert'
import Badge from 'react-bootstrap/Badge'
import Button from 'react-bootstrap/Button'
import Form from 'react-bootstrap/Form'
import Modal from 'react-bootstrap/Modal'
import Spinner from 'react-bootstrap/Spinner'
import Table from 'react-bootstrap/Table'
import { get, patch } from '../api'
import { useAuth } from '../AuthContext.jsx'

const MANAGEMENT_ROLES = new Set(['SALES_MANAGER', 'EXECUTIVE_MANAGER', 'SYSTEM_ADMIN'])

const REQUEST_TYPE_LABELS = {
  ARCHIVE_LEAD: 'Archive Lead',
  PHASE_1_SIGNOFF: 'Phase 1 Signoff',
  PHASE_2_SIGNOFF: 'Phase 2 Signoff',
  PHASE_3_SIGNOFF: 'Phase 3 Signoff',
  STATUS_OVERRIDE: 'Status Override',
}

const STATUS_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'PENDING', label: 'Pending' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'REJECTED', label: 'Rejected' },
]

const STATUS_BADGE_VARIANT = {
  PENDING: 'warning',
  APPROVED: 'success',
  REJECTED: 'danger',
}

function DecisionForm({ mode, saving, error, onSubmit, onHide }) {
  const [decisionNote, setDecisionNote] = useState('')
  const isReject = mode === 'REJECTED'

  return (
    <Form
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit(decisionNote)
      }}
    >
      <Modal.Header closeButton>
        <Modal.Title as="h2" className="h5 mb-0">
          {isReject ? 'Reject Request' : 'Approve Request'}
        </Modal.Title>
      </Modal.Header>
      <Modal.Body>
        {error && <Alert variant="danger">{error}</Alert>}
        <Form.Group controlId="decision-note">
          <Form.Label>Decision note{!isReject && ' (optional)'}</Form.Label>
          <Form.Control
            as="textarea"
            rows={3}
            value={decisionNote}
            onChange={(event) => setDecisionNote(event.target.value)}
            required={isReject}
          />
        </Form.Group>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onHide} disabled={saving}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant={isReject ? 'danger' : 'success'}
          disabled={saving || (isReject && !decisionNote.trim())}
        >
          {saving ? 'Saving…' : isReject ? 'Reject' : 'Approve'}
        </Button>
      </Modal.Footer>
    </Form>
  )
}

function DecisionModal({ pending, saving, error, onSubmit, onHide }) {
  return (
    <Modal show={Boolean(pending)} onHide={onHide} centered>
      {pending && (
        <DecisionForm key={`${pending.approval.id}-${pending.mode}`} mode={pending.mode} saving={saving} error={error} onSubmit={onSubmit} onHide={onHide} />
      )}
    </Modal>
  )
}

export default function Approvals() {
  const { user } = useAuth()
  const canDecide = MANAGEMENT_ROLES.has(user?.role)

  const [status, setStatus] = useState('PENDING')
  const [approvals, setApprovals] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [refreshKey, setRefreshKey] = useState(0)

  const [pendingDecision, setPendingDecision] = useState(null)
  const [deciding, setDeciding] = useState(false)
  const [decisionError, setDecisionError] = useState(null)

  useEffect(() => {
    let cancelled = false

    async function fetchApprovals() {
      setLoading(true)
      setError(null)
      try {
        const data = await get(`/api/approvals/${status ? `?status=${status}` : ''}`)
        if (!cancelled) setApprovals(data)
      } catch {
        if (!cancelled) setError('Failed to load approvals.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchApprovals()
    return () => {
      cancelled = true
    }
  }, [status, refreshKey])

  function openDecision(approval, mode) {
    setDecisionError(null)
    setPendingDecision({ approval, mode })
  }

  async function handleSubmitDecision(decisionNote) {
    setDeciding(true)
    setDecisionError(null)
    try {
      await patch(`/api/approvals/${pendingDecision.approval.id}/`, {
        status: pendingDecision.mode,
        decision_note: decisionNote,
      })
      setPendingDecision(null)
      setRefreshKey((k) => k + 1)
    } catch {
      setDecisionError(`Failed to ${pendingDecision.mode === 'REJECTED' ? 'reject' : 'approve'} that request.`)
    } finally {
      setDeciding(false)
    }
  }

  return (
    <>
      <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
        <h1 className="h3 mb-0">Approvals</h1>
        <Form.Select
          value={status}
          onChange={(event) => setStatus(event.target.value)}
          style={{ maxWidth: '12rem' }}
          aria-label="Filter by status"
        >
          {STATUS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Form.Select>
      </div>

      {error && <Alert variant="danger">{error}</Alert>}

      <DecisionModal
        pending={pendingDecision}
        saving={deciding}
        error={decisionError}
        onSubmit={handleSubmitDecision}
        onHide={() => setPendingDecision(null)}
      />

      {loading ? (
        <div className="d-flex justify-content-center py-5">
          <Spinner animation="border" role="status">
            <span className="visually-hidden">Loading…</span>
          </Spinner>
        </div>
      ) : approvals.length === 0 ? (
        <p className="text-body-secondary">No approval requests found.</p>
      ) : (
        <Table striped bordered hover responsive>
          <thead>
            <tr>
              <th>Lead</th>
              <th>Company</th>
              <th>Request Type</th>
              <th>Requested By</th>
              <th>Reason</th>
              <th>Status</th>
              <th>Date</th>
              {canDecide && <th>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {approvals.map((approval) => {
              const isOwn = approval.requested_by === user.id
              return (
                <tr key={approval.id}>
                  <td>{approval.lead_name ?? '—'}</td>
                  <td>{approval.company_name ?? '—'}</td>
                  <td>
                    {REQUEST_TYPE_LABELS[approval.request_type] ?? approval.request_type}
                    {approval.phase_number ? ` (Phase ${approval.phase_number})` : ''}
                    {approval.requested_status ? ` → ${approval.requested_status}` : ''}
                  </td>
                  <td>{approval.requested_by_username ?? 'Unknown'}</td>
                  <td>{approval.reason || '—'}</td>
                  <td>
                    <Badge bg={STATUS_BADGE_VARIANT[approval.status] ?? 'secondary'}>{approval.status}</Badge>
                  </td>
                  <td>{new Date(approval.created_at).toLocaleDateString()}</td>
                  {canDecide && (
                    <td>
                      {approval.status === 'PENDING' && !isOwn && (
                        <div className="d-flex gap-1">
                          <Button
                            size="sm"
                            variant="outline-success"
                            onClick={() => openDecision(approval, 'APPROVED')}
                          >
                            Approve
                          </Button>
                          <Button
                            size="sm"
                            variant="outline-danger"
                            onClick={() => openDecision(approval, 'REJECTED')}
                          >
                            Reject
                          </Button>
                        </div>
                      )}
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </Table>
      )}
    </>
  )
}
