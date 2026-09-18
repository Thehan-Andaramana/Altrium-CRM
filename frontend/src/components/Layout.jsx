import { formatDistanceToNow } from 'date-fns'
import {
  Bell,
  Building2,
  Calendar,
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
import Dropdown from 'react-bootstrap/Dropdown'
import Form from 'react-bootstrap/Form'
import InputGroup from 'react-bootstrap/InputGroup'
import ListGroup from 'react-bootstrap/ListGroup'
import Nav from 'react-bootstrap/Nav'
import Navbar from 'react-bootstrap/Navbar'
import NavDropdown from 'react-bootstrap/NavDropdown'
import Spinner from 'react-bootstrap/Spinner'
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom'
import { get, patch, post } from '../api'
import { useAuth } from '../AuthContext.jsx'
import { useTheme } from '../ThemeContext.jsx'

const MANAGEMENT_ROLES = new Set(['SALES_MANAGER', 'EXECUTIVE_MANAGER', 'SYSTEM_ADMIN'])
const SIDEBAR_WIDTH = '240px'
const SEARCH_DEBOUNCE_MS = 300
const NOTIFICATION_POLL_MS = 60000

const NAV_ITEMS = [
  { to: '/', end: true, label: 'Home', Icon: LayoutDashboard },
  { to: '/leads', label: 'Pipeline', Icon: GitBranch },
  { to: '/calendar', label: 'Calendar', Icon: Calendar },
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

function GlobalSearch() {
  const containerRef = useRef(null)
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [companyResults, setCompanyResults] = useState([])
  const [leadResults, setLeadResults] = useState([])
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const timeoutId = setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timeoutId)
  }, [query])

  useEffect(() => {
    let cancelled = false

    async function fetchResults() {
      if (!debouncedQuery) {
        setCompanyResults([])
        setLeadResults([])
        return
      }
      try {
        // Both endpoints are already permission-scoped server-side (e.g. a
        // rep's lead search only turns up leads assigned to them), so
        // results here need no extra client-side filtering.
        const [companies, leads] = await Promise.all([
          get(`/api/companies/?search=${encodeURIComponent(debouncedQuery)}`),
          get(`/api/leads/?search=${encodeURIComponent(debouncedQuery)}`),
        ])
        if (!cancelled) {
          setCompanyResults(companies)
          setLeadResults(leads)
        }
      } catch {
        if (!cancelled) {
          setCompanyResults([])
          setLeadResults([])
        }
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

  const hasResults = companyResults.length > 0 || leadResults.length > 0

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
          aria-label="Search companies and leads"
        />
      </InputGroup>
      {open && debouncedQuery && (
        <ListGroup
          className="position-absolute top-100 start-0 end-0 mt-1 shadow-sm"
          style={{ zIndex: 1050, maxHeight: '20rem', overflowY: 'auto' }}
        >
          {!hasResults ? (
            <ListGroup.Item className="text-body-secondary">No results found.</ListGroup.Item>
          ) : (
            <>
              {companyResults.map((company) => (
                <ListGroup.Item
                  key={`company-${company.id}`}
                  as={Link}
                  to={`/companies/${company.id}`}
                  action
                  onClick={handleSelect}
                >
                  {company.name}
                </ListGroup.Item>
              ))}
              {leadResults.map((lead) => (
                <ListGroup.Item
                  key={`lead-${lead.id}`}
                  as={Link}
                  to={`/leads/${lead.id}`}
                  action
                  onClick={handleSelect}
                >
                  <div>{lead.name}</div>
                  <div className="text-body-secondary small">{lead.company_name ?? '—'}</div>
                </ListGroup.Item>
              ))}
            </>
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

function NotificationBell({ user }) {
  const navigate = useNavigate()
  const [unreadCount, setUnreadCount] = useState(0)
  const [mentions, setMentions] = useState([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!user) return
    let cancelled = false

    async function fetchUnreadCount() {
      try {
        const data = await get('/api/notifications/unread_count/')
        // Leave the last known count on a transient failure rather than
        // flashing it to zero -- the next poll self-corrects either way.
        if (!cancelled) setUnreadCount(data.unread_count)
      } catch {
        // Same reasoning -- nothing to do here.
      }
    }

    fetchUnreadCount()
    const intervalId = setInterval(fetchUnreadCount, NOTIFICATION_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(intervalId)
    }
  }, [user])

  async function handleToggle(nextOpen) {
    if (!nextOpen) return
    setLoading(true)
    try {
      const data = await get('/api/notifications/')
      setMentions(data)
    } catch {
      setMentions([])
    } finally {
      setLoading(false)
    }
  }

  function handleSelect(mention) {
    setMentions((prev) => prev.filter((m) => m.id !== mention.id))
    setUnreadCount((prev) => Math.max(0, prev - 1))
    navigate(`/leads/${mention.lead_id}?tab=activity`)
    // Best-effort -- if this fails, the mention just reappears on the next
    // full list fetch and the badge self-corrects on the next 60s poll.
    patch(`/api/notifications/${mention.id}/`, {}).catch(() => {})
  }

  async function handleMarkAllRead(event) {
    event.stopPropagation()
    const previousMentions = mentions
    const previousCount = unreadCount
    setMentions([])
    setUnreadCount(0)
    try {
      await post('/api/notifications/mark-all-read/', {})
    } catch {
      setMentions(previousMentions)
      setUnreadCount(previousCount)
    }
  }

  return (
    <Dropdown align="end" onToggle={handleToggle}>
      <Dropdown.Toggle
        variant="outline-secondary"
        size="sm"
        className="border-0 rounded-circle p-2 position-relative dropdown-toggle-no-caret"
        id="notification-bell"
        aria-label="Notifications"
        title="Notifications"
      >
        <Bell size={18} />
        {unreadCount > 0 && (
          <Badge
            bg="danger"
            pill
            className="position-absolute top-0 start-100 translate-middle"
            style={{ fontSize: '0.6rem' }}
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </Badge>
        )}
      </Dropdown.Toggle>
      <Dropdown.Menu style={{ minWidth: '22rem', maxHeight: '24rem', overflowY: 'auto' }}>
        <div className="d-flex justify-content-between align-items-center px-3 py-1">
          <span className="fw-semibold small">Mentions</span>
          {mentions.length > 0 && (
            <Button variant="link" size="sm" className="p-0" onClick={handleMarkAllRead}>
              Mark all read
            </Button>
          )}
        </div>
        <Dropdown.Divider />
        {loading ? (
          <div className="text-center py-3">
            <Spinner animation="border" size="sm" />
          </div>
        ) : mentions.length === 0 ? (
          <div className="text-body-secondary small px-3 py-2">No unread mentions.</div>
        ) : (
          mentions.map((mention) => (
            <Dropdown.Item
              key={mention.id}
              as="button"
              type="button"
              className="py-2"
              style={{ whiteSpace: 'normal' }}
              onClick={() => handleSelect(mention)}
            >
              <div className="d-flex justify-content-between gap-2">
                <span className="fw-semibold small">{mention.created_by_username ?? 'Someone'}</span>
                <span className="text-body-secondary small flex-shrink-0">
                  {formatDistanceToNow(new Date(mention.created_at), { addSuffix: true })}
                </span>
              </div>
              <div className="text-body-secondary small">{mention.lead_name}</div>
              <div className="small text-truncate">{mention.note_snippet}</div>
            </Dropdown.Item>
          ))
        )}
      </Dropdown.Menu>
    </Dropdown>
  )
}

function UserActions({ theme, onToggleTheme, user, canSeeSettings, onLogout }) {
  return (
    <>
      <NotificationBell user={user} />
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
            <GlobalSearch />
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
              <GlobalSearch />
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
