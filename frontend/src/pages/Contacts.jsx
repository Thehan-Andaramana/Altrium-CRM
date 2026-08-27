import { useEffect, useState } from 'react'
import Alert from 'react-bootstrap/Alert'
import Badge from 'react-bootstrap/Badge'
import Button from 'react-bootstrap/Button'
import Card from 'react-bootstrap/Card'
import Form from 'react-bootstrap/Form'
import ListGroup from 'react-bootstrap/ListGroup'
import Modal from 'react-bootstrap/Modal'
import Spinner from 'react-bootstrap/Spinner'
import { get, patch, post } from '../api'
import { useAuth } from '../AuthContext.jsx'
import ArchiveButton from '../components/ArchiveButton.jsx'

// Contact create/update may be attempted by management (always allowed) or a
// SALES_REP (allowed only on a company where they have an assigned lead --
// enforced server-side by ContactPermission). SYSTEM_ADMIN/DELIVERY_LEAD can
// never write, so the button is hidden for them rather than always failing.
const CAN_ATTEMPT_WRITE_ROLES = new Set(['SALES_MANAGER', 'EXECUTIVE_MANAGER', 'SALES_REP'])

function ContactFields({ name, setName, email, setEmail, phone, setPhone, jobTitle, setJobTitle }) {
  return (
    <>
      <Form.Group className="mb-3" controlId="contact-name">
        <Form.Label>Name</Form.Label>
        <Form.Control value={name} onChange={(event) => setName(event.target.value)} required />
      </Form.Group>
      <Form.Group className="mb-3" controlId="contact-job-title">
        <Form.Label>Job title</Form.Label>
        <Form.Control value={jobTitle} onChange={(event) => setJobTitle(event.target.value)} />
      </Form.Group>
      <Form.Group className="mb-3" controlId="contact-email">
        <Form.Label>Email</Form.Label>
        <Form.Control type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
      </Form.Group>
      <Form.Group controlId="contact-phone">
        <Form.Label>Phone</Form.Label>
        <Form.Control value={phone} onChange={(event) => setPhone(event.target.value)} />
      </Form.Group>
    </>
  )
}

function NewContactModal({ show, onHide, onCreated, companies }) {
  const [companyId, setCompanyId] = useState('')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [jobTitle, setJobTitle] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  async function handleSubmit(event) {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      await post('/api/contacts/', {
        company: Number(companyId),
        name,
        email,
        phone,
        job_title: jobTitle,
      })
      onCreated()
      onHide()
    } catch {
      setError('Failed to create contact.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal show={show} onHide={onHide} centered>
      <Form onSubmit={handleSubmit}>
        <Modal.Header closeButton>
          <Modal.Title as="h2" className="h5 mb-0">
            New Contact
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {error && <Alert variant="danger">{error}</Alert>}
          <Form.Group className="mb-3" controlId="new-contact-company">
            <Form.Label>Company</Form.Label>
            <Form.Select value={companyId} onChange={(event) => setCompanyId(event.target.value)} required>
              <option value="">Select a company…</option>
              {companies.map((company) => (
                <option key={company.id} value={company.id}>
                  {company.name}
                </option>
              ))}
            </Form.Select>
          </Form.Group>
          <ContactFields
            name={name}
            setName={setName}
            email={email}
            setEmail={setEmail}
            phone={phone}
            setPhone={setPhone}
            jobTitle={jobTitle}
            setJobTitle={setJobTitle}
          />
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={onHide} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={saving || !companyId}>
            {saving ? 'Creating…' : 'Create'}
          </Button>
        </Modal.Footer>
      </Form>
    </Modal>
  )
}

function EditContactForm({ contact, saving, error, onSave, onHide }) {
  // Keyed by contact.id from the parent, so switching contacts remounts
  // this with fresh initial state instead of needing an effect to resync it.
  const [name, setName] = useState(contact.name)
  const [email, setEmail] = useState(contact.email ?? '')
  const [phone, setPhone] = useState(contact.phone ?? '')
  const [jobTitle, setJobTitle] = useState(contact.job_title ?? '')

  return (
    <Form
      onSubmit={(event) => {
        event.preventDefault()
        onSave({ name, email, phone, jobTitle })
      }}
    >
      <Modal.Header closeButton>
        <Modal.Title as="h2" className="h5 mb-0">
          Edit Contact
        </Modal.Title>
      </Modal.Header>
      <Modal.Body>
        {error && <Alert variant="danger">{error}</Alert>}
        <ContactFields
          name={name}
          setName={setName}
          email={email}
          setEmail={setEmail}
          phone={phone}
          setPhone={setPhone}
          jobTitle={jobTitle}
          setJobTitle={setJobTitle}
        />
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onHide} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </Modal.Footer>
    </Form>
  )
}

function EditContactModal({ contact, onHide, onSaved }) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  async function handleSave({ name, email, phone, jobTitle }) {
    setSaving(true)
    setError(null)
    try {
      const updated = await patch(`/api/contacts/${contact.id}/`, {
        name,
        email,
        phone,
        job_title: jobTitle,
      })
      onSaved(updated)
      onHide()
    } catch {
      setError('Failed to save contact.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal show={Boolean(contact)} onHide={onHide} centered>
      {contact && <EditContactForm key={contact.id} contact={contact} saving={saving} error={error} onSave={handleSave} onHide={onHide} />}
    </Modal>
  )
}

export default function Contacts() {
  const { user } = useAuth()
  const canAttemptWrite = CAN_ATTEMPT_WRITE_ROLES.has(user?.role)

  const [contacts, setContacts] = useState([])
  const [companies, setCompanies] = useState([])
  const [includeArchived, setIncludeArchived] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [showNewModal, setShowNewModal] = useState(false)
  const [editingContact, setEditingContact] = useState(null)

  useEffect(() => {
    let cancelled = false

    async function fetchAll() {
      setLoading(true)
      setError(null)
      try {
        const query = includeArchived ? '?include_archived=true' : ''
        const [contactsData, companiesData] = await Promise.all([
          get(`/api/contacts/${query}`),
          get('/api/companies/'),
        ])
        if (!cancelled) {
          setContacts(contactsData)
          setCompanies(companiesData)
        }
      } catch {
        if (!cancelled) setError('Failed to load contacts.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchAll()
    return () => {
      cancelled = true
    }
  }, [includeArchived, refreshKey])

  function refresh() {
    setRefreshKey((k) => k + 1)
  }

  const groups = new Map()
  for (const contact of contacts) {
    const key = contact.company
    if (!groups.has(key)) {
      groups.set(key, { companyName: contact.company_name ?? `Company #${key}`, contacts: [] })
    }
    groups.get(key).contacts.push(contact)
  }
  const sortedGroups = [...groups.values()].sort((a, b) => a.companyName.localeCompare(b.companyName))
  for (const group of sortedGroups) {
    group.contacts.sort((a, b) => a.name.localeCompare(b.name))
  }

  return (
    <>
      <div className="d-flex flex-nowrap justify-content-between align-items-center pb-3 mb-4 border-bottom">
        <h1 className="h3 mb-0">Contacts</h1>
        {canAttemptWrite && (
          <Button variant="primary" onClick={() => setShowNewModal(true)}>
            New Contact
          </Button>
        )}
      </div>

      <div className="d-flex flex-column flex-sm-row align-items-sm-center gap-2 mb-3">
        <Form.Switch
          id="contacts-include-archived"
          label="Show archived"
          checked={includeArchived}
          onChange={(event) => setIncludeArchived(event.target.checked)}
        />
      </div>

      {error && <Alert variant="danger">{error}</Alert>}

      {canAttemptWrite && showNewModal && (
        <NewContactModal
          show={showNewModal}
          onHide={() => setShowNewModal(false)}
          onCreated={refresh}
          companies={companies}
        />
      )}

      <EditContactModal
        contact={editingContact}
        onHide={() => setEditingContact(null)}
        onSaved={refresh}
      />

      {loading ? (
        <div className="d-flex justify-content-center py-5">
          <Spinner animation="border" role="status">
            <span className="visually-hidden">Loading…</span>
          </Spinner>
        </div>
      ) : sortedGroups.length === 0 ? (
        <p className="text-body-secondary">No contacts found.</p>
      ) : (
        <div className="d-flex flex-column gap-3">
          {sortedGroups.map((group) => (
            <Card key={group.companyName}>
              <Card.Header className="fw-semibold">{group.companyName}</Card.Header>
              <ListGroup variant="flush">
                {group.contacts.map((contact) => (
                  <ListGroup.Item
                    key={contact.id}
                    className="d-flex justify-content-between align-items-center gap-2"
                  >
                    <div>
                      <div>
                        {contact.name}
                        {contact.is_archived && (
                          <Badge bg="secondary" className="ms-2">
                            Archived
                          </Badge>
                        )}
                      </div>
                      <div className="text-body-secondary small">
                        {contact.job_title || '—'}
                        {contact.email && <> · {contact.email}</>}
                        {contact.phone && <> · {contact.phone}</>}
                      </div>
                    </div>
                    <div className="d-flex align-items-center gap-2 flex-shrink-0">
                      {canAttemptWrite && (
                        <Button variant="outline-secondary" size="sm" onClick={() => setEditingContact(contact)}>
                          Edit
                        </Button>
                      )}
                      <ArchiveButton resource="contact" record={contact} onArchived={refresh} />
                    </div>
                  </ListGroup.Item>
                ))}
              </ListGroup>
            </Card>
          ))}
        </div>
      )}
    </>
  )
}
