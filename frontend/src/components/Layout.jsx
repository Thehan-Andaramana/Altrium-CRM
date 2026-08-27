import {
  Building2,
  CheckSquare,
  ChevronDown,
  GitBranch,
  LayoutDashboard,
  LogOut,
  Moon,
  Search,
  Settings,
  SlidersHorizontal,
  Sun,
  Users,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import Badge from 'react-bootstrap/Badge'
import Button from 'react-bootstrap/Button'
import Container from 'react-bootstrap/Container'
import Form from 'react-bootstrap/Form'
import InputGroup from 'react-bootstrap/InputGroup'
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

const NAV_ITEMS = [
  { to: '/', end: true, label: 'Home', Icon: LayoutDashboard },
  { to: '/leads', label: 'Pipeline', Icon: GitBranch },
  { to: '/companies', label: 'Companies', Icon: Building2, requiresCompaniesAccess: true },
  { to: '/contacts', label: 'Contacts', Icon: Users },
  { to: '/approvals', label: 'Approvals', Icon: CheckSquare, showApprovalsBadge: true },
]

// Amber accent mark: a hexagon with a white chevron, kept fixed-contrast
// (white on amber) regardless of light/dark theme, the same way .btn-accent
// forces ink text on amber -- a logo's internal contrast isn't page theming.
function BrandMark({ className = '', ...props }) {
  return (
    <svg
      viewBox="0 0 28 28"
      width="24"
      height="24"
      aria-hidden="true"
      className={`text-warning flex-shrink-0 ${className}`}
      {...props}
    >
      <path d="M14 1 26 7.5v13L14 27 2 20.5v-13Z" fill="currentColor" />
      <path d="M10 8 18 14l-8 6" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
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
    <div ref={containerRef} className="position-relative" style={{ width: '16rem' }}>
      <InputGroup>
        <InputGroup.Text>
          <Search size={16} />
        </InputGroup.Text>
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
      </InputGroup>
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

function NavLinks({ canSeeCompanies, isManagement, pendingApprovalsCount }) {
  // Deliberately react-router's NavLink directly, not react-bootstrap's
  // Nav.Link wrapper -- that wrapper pre-flattens `className`/`style` with
  // its own classnames() call before handing a plain string down to the
  // "as" component, which breaks the function form NavLink needs for
  // active-route styling. `nav-link` is added by hand below to keep the
  // same Bootstrap base styling Nav.Link would otherwise have supplied.
  return (
    <>
      {NAV_ITEMS.map(({ to, end, label, Icon, requiresCompaniesAccess, showApprovalsBadge }) => {
        if (requiresCompaniesAccess && !canSeeCompanies) {
          return null
        }
        return (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              [
                'nav-link d-inline-flex align-items-center gap-1 px-2 py-1 border-bottom border-3',
                isActive ? 'border-warning fw-medium text-body' : 'text-body-secondary',
              ].join(' ')
            }
            style={({ isActive }) => (isActive ? undefined : { borderBottomColor: 'transparent' })}
          >
            <Icon size={16} />
            {label}
            {showApprovalsBadge && pendingApprovalsCount > 0 && (
              <Badge bg={isManagement ? 'warning' : 'secondary'} text={isManagement ? 'dark' : undefined} pill>
                {pendingApprovalsCount}
              </Badge>
            )}
          </NavLink>
        )
      })}
    </>
  )
}

function UserAvatar({ username }) {
  const initials = (username || '?').slice(0, 2).toUpperCase()
  return (
    <span
      className="d-inline-flex align-items-center justify-content-center rounded-circle bg-warning text-dark fw-semibold flex-shrink-0"
      style={{ width: '2rem', height: '2rem', fontSize: '0.75rem' }}
      aria-hidden="true"
    >
      {initials}
    </span>
  )
}

function UserActions({ theme, onToggleTheme, user, canSeeSettings, onLogout }) {
  return (
    <>
      <Button
        variant="outline-secondary"
        size="sm"
        className="border-0 rounded-circle p-2"
        onClick={onToggleTheme}
        aria-label={theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'}
        title={theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'}
      >
        {theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}
      </Button>
      <NavDropdown
        align="end"
        id="user-menu"
        title={
          <span className="d-inline-flex align-items-center gap-2">
            <UserAvatar username={user?.username} />
            <span className="d-flex flex-column align-items-start lh-sm">
              <span>{user?.username}</span>
              <span className="text-body-secondary small">{user?.role}</span>
            </span>
            <ChevronDown size={16} />
          </span>
        }
      >
        <NavDropdown.Item as={NavLink} to="/preferences">
          <Settings size={16} className="me-2" />
          Preferences
        </NavDropdown.Item>
        {canSeeSettings && (
          <NavDropdown.Item as={NavLink} to="/settings">
            <SlidersHorizontal size={16} className="me-2" />
            System Settings
          </NavDropdown.Item>
        )}
        <NavDropdown.Divider />
        <NavDropdown.Item onClick={onLogout} className="text-danger">
          <LogOut size={16} className="me-2" />
          Logout
        </NavDropdown.Item>
      </NavDropdown>
    </>
  )
}

export default function Layout() {
  const { user, logout } = useAuth()
  const { theme, setTheme, navVariant } = useTheme()
  const navigate = useNavigate()

  const canSeeSettings = user && MANAGEMENT_ROLES.has(user.role)
  const canSeeCompanies = user && (MANAGEMENT_ROLES.has(user.role) || user.role === 'SALES_REP')
  const isManagement = Boolean(canSeeSettings)

  const [pendingApprovalsCount, setPendingApprovalsCount] = useState(0)

  useEffect(() => {
    if (!user) {
      return
    }
    let cancelled = false

    async function fetchPendingCount() {
      try {
        // Already role-scoped server-side (ApprovalRequestViewSet):
        // management roles get every pending request, a rep gets only their
        // own -- exactly the "needs to act" vs "watching my own" split.
        const data = await get('/api/approvals/?status=PENDING')
        if (!cancelled) setPendingApprovalsCount(data.length)
      } catch {
        if (!cancelled) setPendingApprovalsCount(0)
      }
    }

    fetchPendingCount()
    return () => {
      cancelled = true
    }
  }, [user])

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
          <NavLink to="/" className="navbar-brand mb-3 d-flex align-items-center gap-2 fw-semibold">
            <BrandMark />
            Altrium CRM
          </NavLink>
          <div className="mb-3">
            <GlobalCompanySearch />
          </div>
          <Nav className="flex-column gap-1">
            <NavLinks
              canSeeCompanies={canSeeCompanies}
              isManagement={isManagement}
              pendingApprovalsCount={pendingApprovalsCount}
            />
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
      <Navbar expand="md" bg="body-tertiary" className="border-bottom py-3 mb-4" sticky="top">
        <Container fluid>
          <Navbar.Brand as={NavLink} to="/" className="d-flex align-items-center gap-2 fw-semibold">
            <BrandMark />
            Altrium CRM
          </Navbar.Brand>
          <Navbar.Toggle aria-controls="main-navbar" />
          <Navbar.Collapse id="main-navbar">
            <Nav className="me-auto gap-1">
              <NavLinks
                canSeeCompanies={canSeeCompanies}
                isManagement={isManagement}
                pendingApprovalsCount={pendingApprovalsCount}
              />
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
