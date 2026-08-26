import { useState } from 'react'
import Alert from 'react-bootstrap/Alert'
import Button from 'react-bootstrap/Button'
import Form from 'react-bootstrap/Form'
import { post } from '../api'

// A compact "+ New contact" toggle for use inside another modal's form --
// creates a Contact against companyId and hands it back via onCreated,
// without leaving the parent modal.
export default function NewContactInline({ companyId, onCreated }) {
  const [show, setShow] = useState(false)
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  async function handleAdd() {
    if (!name.trim()) {
      return
    }
    setSaving(true)
    setError(null)
    try {
      const created = await post('/api/contacts/', { company: companyId, name })
      onCreated(created)
      setName('')
      setShow(false)
    } catch {
      setError('Failed to create contact.')
    } finally {
      setSaving(false)
    }
  }

  if (!show) {
    return (
      <Button type="button" variant="link" size="sm" className="ps-0" onClick={() => setShow(true)}>
        + New contact
      </Button>
    )
  }

  return (
    <div className="mt-2">
      {error && (
        <Alert variant="danger" className="py-1 px-2 small mb-2">
          {error}
        </Alert>
      )}
      <div className="d-flex gap-2">
        <Form.Control
          size="sm"
          placeholder="Contact name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoFocus
        />
        <Button type="button" size="sm" variant="outline-primary" disabled={saving} onClick={handleAdd}>
          {saving ? 'Adding…' : 'Add'}
        </Button>
        <Button type="button" size="sm" variant="outline-secondary" onClick={() => setShow(false)} disabled={saving}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
