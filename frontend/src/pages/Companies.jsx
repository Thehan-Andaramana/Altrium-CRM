import { useEffect, useState } from 'react'
import Alert from 'react-bootstrap/Alert'
import Form from 'react-bootstrap/Form'
import Spinner from 'react-bootstrap/Spinner'
import Table from 'react-bootstrap/Table'
import { get } from '../api'

const SEARCH_DEBOUNCE_MS = 300

export default function Companies() {
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [companies, setCompanies] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

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
  }, [debouncedSearch])

  return (
    <>
      <div className="d-flex justify-content-between align-items-center mb-3">
        <h1 className="h3 mb-0">Companies</h1>
        <Form.Control
          type="search"
          placeholder="Search companies…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          style={{ maxWidth: '20rem' }}
          aria-label="Search companies"
        />
      </div>

      {error && <Alert variant="danger">{error}</Alert>}

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
                <td>{company.name}</td>
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
                <td>{company.owner ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  )
}
