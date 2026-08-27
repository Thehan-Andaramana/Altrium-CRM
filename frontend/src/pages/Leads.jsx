import { formatDistanceToNow } from 'date-fns'
import { useEffect, useState } from 'react'
import Alert from 'react-bootstrap/Alert'
import Badge from 'react-bootstrap/Badge'
import Button from 'react-bootstrap/Button'
import Form from 'react-bootstrap/Form'
import InputGroup from 'react-bootstrap/InputGroup'
import Modal from 'react-bootstrap/Modal'
import Spinner from 'react-bootstrap/Spinner'
import Table from 'react-bootstrap/Table'
import { Link } from 'react-router-dom'
import { get, post } from '../api'
import { useAuth } from '../AuthContext.jsx'
import SearchIcon from '../components/SearchIcon.jsx'

const SEARCH_DEBOUNCE_MS = 300
// Lead create/update is restricted to SALES_MANAGER/EXECUTIVE_MANAGER --
// SYSTEM_ADMIN is read-only for leads (see ArchivableOwnedResourcePermission, backend).
const MANAGER_ROLES = new Set(['SALES_MANAGER', 'EXECUTIVE_MANAGER'])

const TH_CLASS = 'text-body-secondary text-uppercase small fw-normal table-header-tracked'

const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'HOT', label: 'Hot' },
  { value: 'COLD', label: 'Cold' },
]

const STATUS_BADGE_VARIANT = {
  HOT: 'warning',
  COLD: 'secondary',
}

function NewLeadModal({ show, onHide, onCreated, companies, salesReps }) {
  const [companyId, setCompanyId] = useState('')
  const [contactId, setContactId] = useState('')
  const [contacts, setContacts] = useState([])
  const [loadingContacts, setLoadingContacts] = useState(false)
  const [assignedTo, setAssignedTo] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!companyId) {
      return
    }
    let cancelled = false

    async function fetchContacts() {
      setLoadingContacts(true)
      try {
        const data = await get(`/api/contacts/?company=${companyId}`)
        if (!cancelled) setContacts(data)
      } catch {
        if (!cancelled) setContacts([])
      } finally {
        if (!cancelled) setLoadingContacts(false)
      }
    }

    fetchContacts()
    return () => {
      cancelled = true
    }
  }, [companyId])

  function handleCompanyChange(value) {
    setCompanyId(value)
    setContacts([])
    setContactId('')
  }

  async function handleSubmit(event) {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      await post('/api/leads/', {
        company: Number(companyId),
        contact: contactId ? Number(contactId) : null,
        assigned_to: Number(assignedTo),
      })
      onCreated()
      onHide()
    } catch {
      setError('Failed to create lead.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal show={show} onHide={onHide} centered>
      <Form onSubmit={handleSubmit}>
        <Modal.Header closeButton>
          <Modal.Title as="h2" className="h5 mb-0">
            New Lead
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {error && <Alert variant="danger">{error}</Alert>}
          <Form.Group className="mb-3" controlId="new-lead-company">
            <Form.Label>Company</Form.Label>
            <Form.Select value={companyId} onChange={(event) => handleCompanyChange(event.target.value)} required>
              <option value="">Select a company…</option>
              {companies.map((company) => (
                <option key={company.id} value={company.id}>
                  {company.name}
                </option>
              ))}
            </Form.Select>
          </Form.Group>
          <Form.Group className="mb-3" controlId="new-lead-contact">
            <Form.Label>Contact</Form.Label>
            <Form.Select
              value={contactId}
              onChange={(event) => setContactId(event.target.value)}
              disabled={!companyId || loadingContacts}
            >
              <option value="">No contact</option>
              {contacts.map((contact) => (
                <option key={contact.id} value={contact.id}>
                  {contact.name}
                </option>
              ))}
            </Form.Select>
          </Form.Group>
          <Form.Group controlId="new-lead-assigned">
            <Form.Label>Assigned rep</Form.Label>
            <Form.Select value={assignedTo} onChange={(event) => setAssignedTo(event.target.value)} required>
              <option value="">Select a rep…</option>
              {salesReps.map((rep) => (
                <option key={rep.id} value={rep.id}>
                  {rep.username}
                </option>
              ))}
            </Form.Select>
          </Form.Group>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={onHide} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={saving || !companyId || !assignedTo}>
            {saving ? 'Creating…' : 'Create'}
          </Button>
        </Modal.Footer>
      </Form>
    </Modal>
  )
}

export default function Leads() {
  const { user } = useAuth()
  const canCreate = MANAGER_ROLES.has(user?.role)

  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [status, setStatus] = useState('')
  const [includeArchived, setIncludeArchived] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [leads, setLeads] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [companies, setCompanies] = useState([])
  const [salesReps, setSalesReps] = useState([])
  const [showNewModal, setShowNewModal] = useState(false)

  useEffect(() => {
    const timeoutId = setTimeout(() => setDebouncedSearch(search), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timeoutId)
  }, [search])

  useEffect(() => {
    let cancelled = false

    async function fetchLeads() {
      setLoading(true)
      setError(null)

      const params = new URLSearchParams()
      if (debouncedSearch) {
        params.set('search', debouncedSearch)
      }
      if (status) {
        params.set('status', status)
      }
      if (includeArchived) {
        params.set('include_archived', 'true')
      }
      const query = params.toString()

      try {
        const data = await get(`/api/leads/${query ? `?${query}` : ''}`)
        if (!cancelled) setLeads(data)
      } catch {
        if (!cancelled) setError('Failed to load leads.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchLeads()
    return () => {
      cancelled = true
    }
  }, [debouncedSearch, status, includeArchived, refreshKey])

  useEffect(() => {
    if (!canCreate) {
      return
    }

    let cancelled = false

    async function fetchOptions() {
      try {
        const [companiesData, repsData] = await Promise.all([
          get('/api/companies/'),
          get('/api/users/?role=SALES_REP'),
        ])
        if (!cancelled) {
          setCompanies(companiesData)
          setSalesReps(repsData)
        }
      } catch {
        // New Lead modal dropdowns fall back to empty; rest of the page still works.
      }
    }

    fetchOptions()
    return () => {
      cancelled = true
    }
  }, [canCreate])

  return (
    <>
      <div className="d-flex flex-nowrap justify-content-between align-items-center pb-3 mb-4 border-bottom">
        <h1 className="h3 mb-0">Leads</h1>
        {canCreate && (
          <Button variant="primary" onClick={() => setShowNewModal(true)}>
            New Lead
          </Button>
        )}
      </div>

      <div className="d-flex flex-column flex-sm-row align-items-sm-center gap-2 mb-3">
        <InputGroup style={{ maxWidth: '20rem' }}>
          <InputGroup.Text>
            <SearchIcon />
          </InputGroup.Text>
          <Form.Control
            type="search"
            placeholder="Search leads…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            aria-label="Search leads"
          />
        </InputGroup>
        <div className="d-flex flex-column flex-sm-row gap-2">
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
          <Form.Switch
            id="leads-include-archived"
            label="Show archived"
            checked={includeArchived}
            onChange={(event) => setIncludeArchived(event.target.checked)}
          />
        </div>
      </div>

      {error && <Alert variant="danger">{error}</Alert>}

      {canCreate && showNewModal && (
        <NewLeadModal
          show={showNewModal}
          onHide={() => setShowNewModal(false)}
          onCreated={() => setRefreshKey((k) => k + 1)}
          companies={companies}
          salesReps={salesReps}
        />
      )}

      {loading ? (
        <div className="d-flex justify-content-center py-5">
          <Spinner animation="border" role="status">
            <span className="visually-hidden">Loading…</span>
          </Spinner>
        </div>
      ) : leads.length === 0 ? (
        <p className="text-body-secondary">No leads found.</p>
      ) : (
        <Table striped hover responsive>
          <thead>
            <tr>
              <th className={TH_CLASS}>Company</th>
              <th className={TH_CLASS}>Contact</th>
              <th className={TH_CLASS}>Status</th>
              <th className={TH_CLASS}>Last activity</th>
              <th className={TH_CLASS}>Assigned to</th>
            </tr>
          </thead>
          <tbody>
            {leads.map((lead) => (
              <tr key={lead.id}>
                <td>
                  <Link to={`/leads/${lead.id}`} className="text-decoration-none table-link-hover">
                    {lead.company_name ?? '—'}
                  </Link>
                  {lead.is_archived && (
                    <Badge bg="secondary" className="ms-2">
                      Archived
                    </Badge>
                  )}
                </td>
                <td>{lead.contact_name ?? '—'}</td>
                <td>
                  <Badge bg={STATUS_BADGE_VARIANT[lead.status] ?? 'secondary'}>{lead.status}</Badge>
                </td>
                <td>
                  {lead.last_activity_at
                    ? formatDistanceToNow(new Date(lead.last_activity_at), { addSuffix: true })
                    : '—'}
                </td>
                <td>{lead.assigned_to_username ?? 'Unassigned'}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  )
}
