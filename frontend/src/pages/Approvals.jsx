import { Check, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import Alert from 'react-bootstrap/Alert'
import Button from 'react-bootstrap/Button'
import Form from 'react-bootstrap/Form'
import Spinner from 'react-bootstrap/Spinner'
import Table from 'react-bootstrap/Table'
import { Link } from 'react-router-dom'
import { errorMessage, get, patch } from '../api'
import { useAuth } from '../AuthContext.jsx'
import AppModal from '../components/AppModal.jsx'
import { PersonCell } from '../components/Avatar.jsx'
import FormField from '../components/FormField.jsx'
import { usePageMeta } from '../components/PageChrome.jsx'
import { PlainTh, SortableTh, useSortedRows } from '../components/SortableTable.jsx'
import StatusPill, { APPROVAL_STATUS_TONE } from '../components/StatusPill.jsx'

const MANAGEMENT_ROLES = new Set(['SALES_MANAGER', 'EXECUTIVE_MANAGER', 'SYSTEM_ADMIN'])

const SORT_ACCESSORS = {
  lead: (approval) => approval.lead_name,
  company: (approval) => approval.company_name,
  request_type: (approval) => approval.request_type,
  requested_by: (approval) => approval.requested_by_username,
  status: (approval) => approval.status,
  created_at: (approval) => new Date(approval.created_at).getTime(),
}

const REQUEST_TYPE_LABELS = {
  ARCHIVE_LEAD: 'Archive Lead',
  LEAD_STATUS_CHANGE: 'Lead Status Change',
  PHASE_1_SIGNOFF: 'Phase 1 Signoff',
  PHASE_2_SIGNOFF: 'Phase 2 Signoff',
  PHASE_3_SIGNOFF: 'Phase 3 Signoff',
  PHASE_4_SIGNOFF: 'Phase 4 Signoff',
}

const STATUS_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'PENDING', label: 'Pending' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'REJECTED', label: 'Rejected' },
]

// Why the Approve/Reject buttons aren't on this row. Shown as the View
// link's tooltip, so "no buttons here" is explained rather than just
// observed.
function blockedReason(approval, isOwn, canDecideThis) {
  if (approval.status !== 'PENDING') {
    const decidedBy = approval.decided_by_username ? ` by ${approval.decided_by_username}` : ''
    return `Already ${approval.status.toLowerCase()}${decidedBy}.`
  }
  if (isOwn) {
    return 'You raised this request, so someone else has to decide it.'
  }
  if (!canDecideThis) {
    return 'Only an executive manager can decide a Phase 4 sign-off.'
  }
  return undefined
}

function DecisionForm({ mode, saving, error, onSubmit, onHide }) {
  const [decisionNote, setDecisionNote] = useState('')
  const isReject = mode === 'REJECTED'

  return (
    <AppModal
      onHide={onHide}
      icon={isReject ? X : Check}
      title={isReject ? 'Reject Request' : 'Approve Request'}
      subtitle={
        isReject
          ? 'Say what needs to change — the requester sees this note.'
          : 'Approving releases the next step of the phase.'
      }
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit(decisionNote)
      }}
      actions={
        <>
          <Button variant="outline-secondary" onClick={onHide} disabled={saving}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant={isReject ? 'danger' : 'primary'}
            disabled={saving || (isReject && !decisionNote.trim())}
          >
            {saving ? 'Saving…' : isReject ? 'Reject' : 'Approve'}
          </Button>
        </>
      }
    >
      {error && <Alert variant="danger">{error}</Alert>}
      <FormField
        label={`Decision note${isReject ? '' : ' (optional)'}`}
        controlId="decision-note"
        required={isReject}
      >
        <Form.Control
          as="textarea"
          rows={3}
          value={decisionNote}
          onChange={(event) => setDecisionNote(event.target.value)}
          required={isReject}
        />
      </FormField>
    </AppModal>
  )
}

function DecisionModal({ pending, saving, error, onSubmit, onHide }) {
  // The form owns the dialog so the key below remounts it -- a fresh note
  // per decision, rather than the previous one lingering.
  if (!pending) {
    return null
  }
  return (
    <DecisionForm
      key={`${pending.approval.id}-${pending.mode}`}
      mode={pending.mode}
      saving={saving}
      error={error}
      onSubmit={onSubmit}
      onHide={onHide}
    />
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

  const { rows: sortedApprovals, sort, toggle: toggleSort } = useSortedRows(approvals, SORT_ACCESSORS)

  usePageMeta({ title: 'Approvals' })

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
    } catch (err) {
      setDecisionError(errorMessage(err, `Failed to ${pendingDecision.mode === 'REJECTED' ? 'reject' : 'approve'} that request.`))
    } finally {
      setDeciding(false)
    }
  }

  return (
    <>
      <div className="d-flex flex-column flex-sm-row align-items-sm-center gap-2 mb-3">
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
        <Table hover responsive className="table-cards">
          <thead>
            <tr>
              <SortableTh columnKey="lead" label="Lead" sort={sort} onToggle={toggleSort} />
              <SortableTh columnKey="company" label="Company" sort={sort} onToggle={toggleSort} />
              <SortableTh columnKey="request_type" label="Request Type" sort={sort} onToggle={toggleSort} />
              <SortableTh columnKey="requested_by" label="Requested By" sort={sort} onToggle={toggleSort} />
              <PlainTh label="Reason" />
              <SortableTh columnKey="status" label="Status" sort={sort} onToggle={toggleSort} />
              <SortableTh columnKey="created_at" label="Date" sort={sort} onToggle={toggleSort} />
              {canDecide && <PlainTh label="Actions" />}
            </tr>
          </thead>
          <tbody>
            {sortedApprovals.map((approval) => {
              const isOwn = approval.requested_by === user.id
              // PHASE_4_SIGNOFF (Executive Sign-Off) can only be decided by
              // an EXECUTIVE_MANAGER, not just any management role -- matches
              // the backend's per-request-type decider check.
              const canDecideThis =
                canDecide
                && (approval.request_type !== 'PHASE_4_SIGNOFF' || user.role === 'EXECUTIVE_MANAGER')
              return (
                <tr key={approval.id}>
                  <td>
                    {approval.lead_id ? (
                      <Link
                        to={`/leads/${approval.lead_id}?tab=${approval.phase_number ? 'phases' : 'activity'}`}
                        className="text-decoration-none table-link-hover"
                      >
                        {approval.lead_name ?? '—'}
                      </Link>
                    ) : (
                      approval.lead_name ?? '—'
                    )}
                  </td>
                  <td>{approval.company_name ?? '—'}</td>
                  <td>
                    {REQUEST_TYPE_LABELS[approval.request_type] ?? approval.request_type}
                    {approval.phase_number ? ` (Phase ${approval.phase_number})` : ''}
                    {approval.request_type === 'LEAD_STATUS_CHANGE' && approval.target_status
                      ? ` → ${approval.target_status}`
                      : ''}
                  </td>
                  <td>
                    <PersonCell name={approval.requested_by_username} fallback="Unknown" />
                  </td>
                  <td>{approval.reason || '—'}</td>
                  <td>
                    <StatusPill tone={APPROVAL_STATUS_TONE[approval.status] ?? 'grey'}>
                      {approval.status}
                    </StatusPill>
                  </td>
                  <td>{new Date(approval.created_at).toLocaleDateString()}</td>
                  {canDecide && (
                    <td>
                      {approval.status === 'PENDING' && !isOwn && canDecideThis ? (
                        <div className="d-flex gap-1">
                          {/* Icon buttons, but the aria-label keeps each
                              one's name the word it replaced. */}
                          <button
                            type="button"
                            className="icon-button icon-button--success"
                            onClick={() => openDecision(approval, 'APPROVED')}
                            aria-label="Approve"
                            title="Approve"
                          >
                            <Check size={16} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className="icon-button icon-button--danger"
                            onClick={() => openDecision(approval, 'REJECTED')}
                            aria-label="Reject"
                            title="Reject"
                          >
                            <X size={16} aria-hidden="true" />
                          </button>
                        </div>
                      ) : (
                        // Never an empty cell: a row you can't act on here
                        // still has somewhere to go, and says why not.
                        <Link
                          to={
                            approval.lead_id
                              ? `/leads/${approval.lead_id}?tab=${approval.phase_number ? 'phases' : 'activity'}`
                              : '/approvals'
                          }
                          className="btn btn-sm btn-outline-secondary"
                          title={blockedReason(approval, isOwn, canDecideThis)}
                        >
                          View
                        </Link>
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
