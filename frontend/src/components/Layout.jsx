import { useEffect, useRef, useState } from 'react'
import Badge from 'react-bootstrap/Badge'
import Button from 'react-bootstrap/Button'
import Container from 'react-bootstrap/Container'
import Form from 'react-bootstrap/Form'
import ListGroup from 'react-bootstrap/ListGroup'
import Nav from 'react-bootstrap/Nav'
import Navbar from 'react-bootstrap/Navbar'
import NavDropdown from 'react-bootstrap/NavDropdown'
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom'
import { get } from '../api'
import { useAuth } from '../AuthContext.jsx'
import { useTheme } from '../ThemeContext.jsx'

const MANAGEMENT_ROLES = new Set(['SALES_MANAGER', 'EXECUTIVE_MANAGER', 'SYSTEM_ADMIN'])
const SIDEBAR_WIDTH = '240px'
const SEARCH_DEBOUNCE_MS = 300

function SunIcon(props) {
  return (
    <svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" aria-hidden="true" {...props}>
      <circle cx="8" cy="8" r="3.5" fill="currentColor" />
      <g stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
        <line x1="8" y1="0.5" x2="8" y2="2.5" />
        <line x1="8" y1="13.5" x2="8" y2="15.5" />
        <line x1="0.5" y1="8" x2="2.5" y2="8" />
        <line x1="13.5" y1="8" x2="15.5" y2="8" />
        <line x1="2.6" y1="2.6" x2="4" y2="4" />
        <line x1="12" y1="12" x2="13.4" y2="13.4" />
        <line x1="2.6" y1="13.4" x2="4" y2="12" />
        <line x1="12" y1="4" x2="13.4" y2="2.6" />
      </g>
    </svg>
  )
}

function MoonIcon(props) {
  return (
    <svg viewBox="0 0 16 16" width="1em" height="1em" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M9.8 1.3a6.7 6.7 0 1 0 4.9 11.2 5.6 5.6 0 0 1-4.9-11.2z" />
    </svg>
  )
}

function GlobalCompanySearch() {
  const containerRef = useRef(null)
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [results, setResults] = useState([])
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const timeoutId = setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timeoutId)
  }, [query])

  useEffect(() => {
    let cancelled = false

    async function fetchResults() {
      if (!debouncedQuery) {
        setResults([])
        return
      }
      try {
        const data = await get(`/api/companies/?search=${encodeURIComponent(debouncedQuery)}`)
        if (!cancelled) setResults(data)
      } catch {
        if (!cancelled) setResults([])
      }
    }

    fetchResults()
    return () => {
      cancelled = true
    }
  }, [debouncedQuery])

  useEffect(() => {
    function handleClickOutside(event) {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  function handleSelect() {
    setOpen(false)
    setQuery('')
  }

  return (
    <div ref={containerRef} className="position-relative" style={{ minWidth: '16rem' }}>
      <Form.Control
        type="search"
        placeholder="Search companies…"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        aria-label="Search companies"
      />
      {open && debouncedQuery && (
        <ListGroup
          className="position-absolute top-100 start-0 end-0 mt-1 shadow-sm"
          style={{ zIndex: 1050, maxHeight: '20rem', overflowY: 'auto' }}
        >
          {results.length === 0 ? (
            <ListGroup.Item className="text-body-secondary">No companies found.</ListGroup.Item>
          ) : (
            results.map((company) => (
              <ListGroup.Item key={company.id} as={Link} to={`/companies/${company.id}`} action onClick={handleSelect}>
                {company.name}
              </ListGroup.Item>
            ))
          )}
        </ListGroup>
      )}
    </div>
  )
}

function NavLinks({ canSeeCompanies, canSeeSettings }) {
  return (
    <>
      <Nav.Link as={NavLink} to="/" end>
        Home
      </Nav.Link>
      {canSeeCompanies && (
        <Nav.Link as={NavLink} to="/companies">
          Companies
        </Nav.Link>
      )}
      <Nav.Link as={NavLink} to="/leads">
        Pipeline
      </Nav.Link>
      {canSeeSettings && (
        <Nav.Link as={NavLink} to="/settings">
          Settings
        </Nav.Link>
      )}
    </>
  )
}

function UserActions({ theme, onToggleTheme, user, canSeeSettings, onLogout }) {
  return (
    <>
      <Button
        variant="outline-secondary"
        size="sm"
        onClick={onToggleTheme}
        aria-label={theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'}
        title={theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'}
      >
        {theme === 'light' ? <MoonIcon /> : <SunIcon />}
      </Button>
      <NavDropdown title={user?.username} align="end" id="user-menu">
        <NavDropdown.ItemText>
          <Badge bg="secondary">{user?.role}</Badge>
        </NavDropdown.ItemText>
        <NavDropdown.Item as={NavLink} to="/preferences">
          Preferences
        </NavDropdown.Item>
        {canSeeSettings && (
          <NavDropdown.Item as={NavLink} to="/settings">
            System Settings
          </NavDropdown.Item>
        )}
        <NavDropdown.Divider />
        <NavDropdown.Item onClick={onLogout}>Logout</NavDropdown.Item>
      </NavDropdown>
    </>
  )
}

export default function Layout() {
  const { user, logout } = useAuth()
  const { theme, setTheme, navVariant } = useTheme()
  const navigate = useNavigate()

  const canSeeSettings = user && MANAGEMENT_ROLES.has(user.role)
  const canSeeCompanies = user && MANAGEMENT_ROLES.has(user.role)

  function toggleTheme() {
    setTheme(theme === 'light' ? 'dark' : 'light')
  }

  async function handleLogout() {
    await logout()
    navigate('/login', { replace: true })
  }

  if (navVariant === 'sidebar') {
    return (
      <div className="d-flex">
        <div
          className="d-flex flex-column border-end bg-body-tertiary p-3 position-fixed top-0 start-0 vh-100"
          style={{ width: SIDEBAR_WIDTH }}
        >
          <NavLink to="/" className="navbar-brand mb-3">
            Altrium CRM
          </NavLink>
          <div className="mb-3">
            <GlobalCompanySearch />
          </div>
          <Nav className="flex-column">
            <NavLinks canSeeCompanies={canSeeCompanies} canSeeSettings={canSeeSettings} />
          </Nav>
          <div className="mt-auto d-flex flex-column gap-2 pt-3">
            <UserActions
              theme={theme}
              onToggleTheme={toggleTheme}
              user={user}
              canSeeSettings={canSeeSettings}
              onLogout={handleLogout}
            />
          </div>
        </div>

        <Container as="main" fluid className="py-4" style={{ marginLeft: SIDEBAR_WIDTH }}>
          <Outlet />
        </Container>
      </div>
    )
  }

  return (
    <>
      <Navbar expand="md" bg="body-tertiary" className="border-bottom mb-4">
        <Container fluid>
          <Navbar.Brand as={NavLink} to="/">
            Altrium CRM
          </Navbar.Brand>
          <Navbar.Toggle aria-controls="main-navbar" />
          <Navbar.Collapse id="main-navbar">
            <Nav className="me-auto">
              <NavLinks canSeeCompanies={canSeeCompanies} canSeeSettings={canSeeSettings} />
            </Nav>
            <div className="mx-md-3 my-2 my-md-0">
              <GlobalCompanySearch />
            </div>
            <Nav className="align-items-md-center gap-2">
              <UserActions
                theme={theme}
                onToggleTheme={toggleTheme}
                user={user}
                canSeeSettings={canSeeSettings}
                onLogout={handleLogout}
              />
            </Nav>
          </Navbar.Collapse>
        </Container>
      </Navbar>

      <Container as="main">
        <Outlet />
      </Container>
    </>
  )
}
