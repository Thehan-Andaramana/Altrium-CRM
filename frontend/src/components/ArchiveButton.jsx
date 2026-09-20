import { Archive } from 'lucide-react'
import { useState } from 'react'
import Alert from 'react-bootstrap/Alert'
import Button from 'react-bootstrap/Button'
import Form from 'react-bootstrap/Form'
import { errorMessage, post } from '../api'
import { useAuth } from '../AuthContext.jsx'
import AppModal from './AppModal.jsx'
import FormField from './FormField.jsx'

// Company/Lead/Project archive-or-create rights are narrower than the usual
// "management roles" set -- SYSTEM_ADMIN is excluded (read-only + hard-delete
// only), per CompanyPermission/ArchivableOwnedResourcePermission on the backend.
const MANAGER_ROLES = new Set(['SALES_MANAGER', 'EXECUTIVE_MANAGER'])

const RESOURCE_ENDPOINTS = {
  company: 'companies',
  lead: 'leads',
  project: 'projects',
  contact: 'contacts',
}

function UnarchiveButton({ resource, record, onArchived, label, renderTrigger }) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  async function handleUnarchive() {
    setSaving(true)
    setError(null)
    try {
      await post(`/api/${RESOURCE_ENDPOINTS[resource]}/${record.id}/unarchive/`)
      onArchived()
    } catch (err) {
      setError(errorMessage(err, 'Failed to unarchive.'))
    } finally {
      setSaving(false)
    }
  }

  const triggerLabel = saving ? 'Unarchiving…' : (label ?? 'Unarchive')

  if (renderTrigger) {
    return renderTrigger({ onClick: handleUnarchive, label: triggerLabel, disabled: saving, error })
  }

  return (
    <div className="d-flex align-items-center gap-2">
      {error && (
        <span className="text-danger small" role="alert">
          {error}
        </span>
      )}
      <Button variant="outline-secondary" size="sm" disabled={saving} onClick={handleUnarchive}>
        {triggerLabel}
      </Button>
    </div>
  )
}

// Management roles archive Company/Lead/Project/Contact directly, and are
// the only ones who can unarchive. SALES_REP has no archive rights at all --
// for a Lead specifically, they instead raise an ARCHIVE_LEAD approval
// request, which a manager approving then archives (see
// ApprovalRequestSerializer._apply_approval_side_effect on the backend).
export default function ArchiveButton({ resource, record, onArchived, label, renderTrigger }) {
  const { user } = useAuth()
  const isManagement = MANAGER_ROLES.has(user?.role)
  const canRequestArchive = user?.role === 'SALES_REP' && resource === 'lead'

  const [show, setShow] = useState(false)
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  if (record.is_archived) {
    if (!isManagement) {
      return null
    }
    return (
      <UnarchiveButton
        resource={resource}
        record={record}
        onArchived={onArchived}
        label={label}
        renderTrigger={renderTrigger}
      />
    )
  }

  if (!(isManagement || canRequestArchive)) {
    return null
  }

  function openModal() {
    setReason('')
    setError(null)
    setShow(true)
  }

  async function handleSubmit(event) {
    event.preventDefault()
    if (!reason.trim()) {
      setError('A reason is required.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      if (isManagement) {
        await post(`/api/${RESOURCE_ENDPOINTS[resource]}/${record.id}/archive/`, { archive_reason: reason })
      } else {
        await post('/api/approvals/', { request_type: 'ARCHIVE_LEAD', lead: record.id, reason })
      }
      setShow(false)
      onArchived()
    } catch (err) {
      setError(errorMessage(err, isManagement ? 'Failed to archive.' : 'Failed to submit the archive request.'))
    } finally {
      setSaving(false)
    }
  }

  const triggerLabel = isManagement ? (label ?? 'Archive') : 'Request archive'

  return (
    <>
      {renderTrigger ? (
        renderTrigger({ onClick: openModal, label: triggerLabel, disabled: false, error: null })
      ) : (
        <Button variant="outline-danger" size="sm" onClick={openModal}>
          {triggerLabel}
        </Button>
      )}
      <AppModal
        show={show}
        onHide={() => setShow(false)}
        icon={Archive}
        title={triggerLabel}
        subtitle={
          isManagement
            ? 'Archived records stay readable, and the reason travels with them.'
            : 'A manager decides archive requests — say why this should be archived.'
        }
        onSubmit={handleSubmit}
        actions={
          <>
            <Button variant="outline-secondary" onClick={() => setShow(false)} disabled={saving}>
              Cancel
            </Button>
            {/* Destructive, so this one keeps the danger variant rather
                than the usual near-black primary. */}
            <Button type="submit" variant="danger" disabled={saving}>
              {saving ? 'Saving…' : isManagement ? 'Archive' : 'Submit request'}
            </Button>
          </>
        }
      >
        {error && <Alert variant="danger">{error}</Alert>}
        <FormField label="Reason" controlId="archive-reason" required>
          <Form.Control
            as="textarea"
            rows={3}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            required
          />
        </FormField>
      </AppModal>
    </>
  )
}
