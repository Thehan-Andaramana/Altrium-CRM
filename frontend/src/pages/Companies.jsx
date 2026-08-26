import { useEffect, useState } from 'react'
import Alert from 'react-bootstrap/Alert'
import Badge from 'react-bootstrap/Badge'
import Button from 'react-bootstrap/Button'
import Form from 'react-bootstrap/Form'
import Modal from 'react-bootstrap/Modal'
import Spinner from 'react-bootstrap/Spinner'
import Table from 'react-bootstrap/Table'
import { Link } from 'react-router-dom'
import { get, patch, post } from '../api'
import { useAuth } from '../AuthContext.jsx'

const SEARCH_DEBOUNCE_MS = 300
// Company create/update is restricted to SALES_MANAGER/EXECUTIVE_MANAGER --
// SYSTEM_ADMIN is read-only for companies (see CompanyPermission, backend).
const OWNER_EDIT_ROLES = new Set(['SALES_MANAGER', 'EXECUTIVE_MANAGER'])

function NewCompanyModal({ show, onHide, onCreated, salesReps }) {
  const [name, setName] = useState('')
  const [industry, setIndustry] = useState('')
  const [website, setWebsite] = useState('')
  const [owner, setOwner] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  async function handleSubmit(event) {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      await post('/api/companies/', {
        name,
        industry,
        website,
        owner: owner ? Number(owner) : null,
      })
      onCreated()
      onHide()
    } catch {
      setError('Failed to create company.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal show={show} onHide={onHide} centered>
      <Form onSubmit={handleSubmit}>
        <Modal.Header closeButton>
          <Modal.Title as="h2" className="h5 mb-0">
            New Company
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {error && <Alert variant="danger">{error}</Alert>}
          <Form.Group className="mb-3" controlId="new-company-name">
            <Form.Label>Name</Form.Label>
            <Form.Control value={name} onChange={(event) => setName(event.target.value)} required />
          </Form.Group>
          <Form.Group className="mb-3" controlId="new-company-industry">
            <Form.Label>Industry</Form.Label>
            <Form.Control value={industry} onChange={(event) => setIndustry(event.target.value)} />
          </Form.Group>
          <Form.Group className="mb-3" controlId="new-company-website">
            <Form.Label>Website</Form.Label>
            <Form.Control type="url" value={website} onChange={(event) => setWebsite(event.target.value)} />
          </Form.Group>
          <Form.Group controlId="new-company-owner">
            <Form.Label>Owner</Form.Label>
            <Form.Select value={owner} onChange={(event) => setOwner(event.target.value)}>
              <option value="">Unassigned</option>
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
          <Button type="submit" variant="primary" disabled={saving}>
            {saving ? 'Creating…' : 'Create'}
          </Button>
        </Modal.Footer>
      </Form>
    </Modal>
  )
}

export default function Companies() {
  const { user } = useAuth()
  const canEditOwner = OWNER_EDIT_ROLES.has(user?.role)
  const canCreate = canEditOwner

  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [includeArchived, setIncludeArchived] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [companies, setCompanies] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [salesReps, setSalesReps] = useState([])
  const [savingOwnerId, setSavingOwnerId] = useState(null)
  const [ownerError, setOwnerError] = useState(null)
  const [showNewModal, setShowNewModal] = useState(false)

  useEffect(() => {
    const timeoutId = setTimeout(() => setDebouncedSearch(search), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timeoutId)
  }, [search])

  useEffect(() => {
    let cancelled = false

    async function fetchCompanies() {
      setLoading(true)
      setError(null)

      const params = new URLSearchParams()
      if (debouncedSearch) {
        params.set('search', debouncedSearch)
      }
      if (includeArchived) {
        params.set('include_archived', 'true')
      }
      const query = params.toString()

      try {
        const data = await get(`/api/companies/${query ? `?${query}` : ''}`)
        if (!cancelled) setCompanies(data)
      } catch {
        if (!cancelled) setError('Failed to load companies.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchCompanies()
    return () => {
      cancelled = true
    }
  }, [debouncedSearch, includeArchived, refreshKey])

  useEffect(() => {
    if (!canEditOwner) {
      return
    }

    let cancelled = false

    async function fetchSalesReps() {
      try {
        const data = await get('/api/users/?role=SALES_REP')
        if (!cancelled) setSalesReps(data)
      } catch {
        // Owner dropdown just falls back to "no reps available"; the rest of the page still works.
      }
    }

    fetchSalesReps()
    return () => {
      cancelled = true
    }
  }, [canEditOwner])

  async function handleOwnerChange(company, ownerId) {
    setSavingOwnerId(company.id)
    setOwnerError(null)
    try {
      const updated = await patch(`/api/companies/${company.id}/`, {
        owner: ownerId ? Number(ownerId) : null,
      })
      setCompanies((prev) => prev.map((c) => (c.id === company.id ? updated : c)))
    } catch {
      setOwnerError(`Failed to update owner for ${company.name}.`)
    } finally {
      setSavingOwnerId(null)
    }
  }

  return (
    <>
      <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
        <h1 className="h3 mb-0">Companies</h1>
        <div className="d-flex flex-wrap align-items-center gap-2">
          <Form.Check
            type="checkbox"
            id="companies-include-archived"
            label="Show archived"
            checked={includeArchived}
            onChange={(event) => setIncludeArchived(event.target.checked)}
          />
          <Form.Control
            type="search"
            placeholder="Search companies…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            style={{ maxWidth: '20rem' }}
            aria-label="Search companies"
          />
          {canCreate && (
            <Button variant="primary" onClick={() => setShowNewModal(true)}>
              New Company
            </Button>
          )}
        </div>
      </div>

      {error && <Alert variant="danger">{error}</Alert>}
      {ownerError && <Alert variant="danger">{ownerError}</Alert>}

      {canCreate && showNewModal && (
        <NewCompanyModal
          show={showNewModal}
          onHide={() => setShowNewModal(false)}
          onCreated={() => setRefreshKey((k) => k + 1)}
          salesReps={salesReps}
        />
      )}

      {loading ? (
        <div className="d-flex justify-content-center py-5">
          <Spinner animation="border" role="status">
            <span className="visually-hidden">Loading…</span>
          </Spinner>
        </div>
      ) : companies.length === 0 ? (
        <p className="text-body-secondary">No companies found.</p>
      ) : (
        <Table striped bordered hover responsive>
          <thead>
            <tr>
              <th>Name</th>
              <th>Industry</th>
              <th>Website</th>
              <th>Owner</th>
            </tr>
          </thead>
          <tbody>
            {companies.map((company) => (
              <tr key={company.id}>
                <td>
                  <Link to={`/companies/${company.id}`}>{company.name}</Link>
                  {company.is_archived && (
                    <Badge bg="secondary" className="ms-2">
                      Archived
                    </Badge>
                  )}
                </td>
                <td>{company.industry || '—'}</td>
                <td>
                  {company.website ? (
                    <a href={company.website} target="_blank" rel="noreferrer">
                      {company.website}
                    </a>
                  ) : (
                    '—'
                  )}
                </td>
                <td>
                  {canEditOwner ? (
                    <Form.Select
                      size="sm"
                      value={company.owner ?? ''}
                      onChange={(event) => handleOwnerChange(company, event.target.value)}
                      disabled={savingOwnerId === company.id}
                      aria-label={`Owner for ${company.name}`}
                    >
                      <option value="">Unassigned</option>
                      {salesReps.map((rep) => (
                        <option key={rep.id} value={rep.id}>
                          {rep.username}
                        </option>
                      ))}
                    </Form.Select>
                  ) : (
                    company.owner_username ?? 'Unassigned'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  )
}
