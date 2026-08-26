import { useState } from 'react'
import Alert from 'react-bootstrap/Alert'
import Button from 'react-bootstrap/Button'
import Form from 'react-bootstrap/Form'
import Modal from 'react-bootstrap/Modal'
import { post } from '../api'
import { useAuth } from '../AuthContext.jsx'

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

function UnarchiveButton({ resource, record, onArchived }) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  async function handleUnarchive() {
    setSaving(true)
    setError(null)
    try {
      await post(`/api/${RESOURCE_ENDPOINTS[resource]}/${record.id}/unarchive/`)
      onArchived()
    } catch {
      setError('Failed to unarchive.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="d-flex align-items-center gap-2">
      {error && (
        <span className="text-danger small" role="alert">
          {error}
        </span>
      )}
      <Button variant="outline-secondary" size="sm" disabled={saving} onClick={handleUnarchive}>
        {saving ? 'Unarchiving…' : 'Unarchive'}
      </Button>
    </div>
  )
}

// Management roles archive Company/Lead/Project/Contact directly, and are
// the only ones who can unarchive. SALES_REP has no archive rights at all --
// for a Lead specifically, they instead raise an ARCHIVE_LEAD approval
// request, which a manager approving then archives (see
// ApprovalRequestSerializer._apply_approval_side_effect on the backend).
export default function ArchiveButton({ resource, record, onArchived }) {
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
    return <UnarchiveButton resource={resource} record={record} onArchived={onArchived} />
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
    } catch {
      setError(isManagement ? 'Failed to archive.' : 'Failed to submit the archive request.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <Button variant="outline-danger" size="sm" onClick={openModal}>
        {isManagement ? 'Archive' : 'Request archive'}
      </Button>
      <Modal show={show} onHide={() => setShow(false)} centered>
        <Form onSubmit={handleSubmit}>
          <Modal.Header closeButton>
            <Modal.Title as="h2" className="h5 mb-0">
              {isManagement ? 'Archive' : 'Request archive'}
            </Modal.Title>
          </Modal.Header>
          <Modal.Body>
            {error && <Alert variant="danger">{error}</Alert>}
            <Form.Group controlId="archive-reason">
              <Form.Label>Reason</Form.Label>
              <Form.Control
                as="textarea"
                rows={3}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                required
              />
            </Form.Group>
          </Modal.Body>
          <Modal.Footer>
            <Button variant="secondary" onClick={() => setShow(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" variant="danger" disabled={saving}>
              {saving ? 'Saving…' : isManagement ? 'Archive' : 'Submit request'}
            </Button>
          </Modal.Footer>
        </Form>
      </Modal>
    </>
  )
}
