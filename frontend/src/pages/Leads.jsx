import { formatDistanceToNow } from 'date-fns'
import { useEffect, useState } from 'react'
import Alert from 'react-bootstrap/Alert'
import Badge from 'react-bootstrap/Badge'
import Form from 'react-bootstrap/Form'
import Spinner from 'react-bootstrap/Spinner'
import Table from 'react-bootstrap/Table'
import { Link } from 'react-router-dom'
import { get } from '../api'

const SEARCH_DEBOUNCE_MS = 300

const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'HOT', label: 'Hot' },
  { value: 'COLD', label: 'Cold' },
]

const STATUS_BADGE_VARIANT = {
  HOT: 'warning',
  COLD: 'secondary',
}

export default function Leads() {
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [status, setStatus] = useState('')
  const [leads, setLeads] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

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
  }, [debouncedSearch, status])

  return (
    <>
      <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
        <h1 className="h3 mb-0">Leads</h1>
        <div className="d-flex gap-2">
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
          <Form.Control
            type="search"
            placeholder="Search leads…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            style={{ maxWidth: '20rem' }}
            aria-label="Search leads"
          />
        </div>
      </div>

      {error && <Alert variant="danger">{error}</Alert>}

      {loading ? (
        <div className="d-flex justify-content-center py-5">
          <Spinner animation="border" role="status">
            <span className="visually-hidden">Loading…</span>
          </Spinner>
        </div>
      ) : leads.length === 0 ? (
        <p className="text-body-secondary">No leads found.</p>
      ) : (
        <Table striped bordered hover responsive>
          <thead>
            <tr>
              <th>Company</th>
              <th>Contact</th>
              <th>Status</th>
              <th>Last activity</th>
              <th>Assigned to</th>
            </tr>
          </thead>
          <tbody>
            {leads.map((lead) => (
              <tr key={lead.id}>
                <td>
                  <Link to={`/leads/${lead.id}`}>{lead.company_name ?? '—'}</Link>
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
