import { formatDistanceToNow } from 'date-fns'
import { Bell, Moon, Search, Sun } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import Button from 'react-bootstrap/Button'
import Dropdown from 'react-bootstrap/Dropdown'
import Form from 'react-bootstrap/Form'
import InputGroup from 'react-bootstrap/InputGroup'
import ListGroup from 'react-bootstrap/ListGroup'
import Spinner from 'react-bootstrap/Spinner'
import { Link, matchPath, useLocation, useNavigate } from 'react-router-dom'
import { get, patch, post } from '../api'
import StatusPill from './StatusPill.jsx'
import { usePageChrome } from './PageChrome.jsx'
import { useTheme } from '../ThemeContext.jsx'

const SEARCH_DEBOUNCE_MS = 300

// Shown while a page is still loading (and so hasn't set its own title
// yet), so the header never flashes empty between routes. A detail route's
// entry is the record *type* -- the record's own name replaces it as soon
// as it arrives.
const ROUTE_TITLES = [
  { path: '/', end: true, title: 'Dashboard' },
  { path: '/board', title: 'Board' },
  { path: '/leads', end: true, title: 'Leads' },
  { path: '/leads/:id', title: 'Lead' },
  { path: '/companies', end: true, title: 'Companies' },
  { path: '/companies/:id', title: 'Company' },
  { path: '/contacts', title: 'Contacts' },
  { path: '/calendar', title: 'Calendar' },
  { path: '/approvals', title: 'Approvals' },
  { path: '/reports', title: 'Reports' },
  { path: '/preferences', title: 'Preferences' },
  { path: '/settings', title: 'System Settings' },
]

function routeTitle(pathname) {
  for (const route of ROUTE_TITLES) {
    if (matchPath({ path: route.path, end: route.end ?? false }, pathname)) {
      return route.title
    }
  }
  return 'Altrium CRM'
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
    <div ref={containerRef} className="position-relative flex-grow-1" style={{ maxWidth: '20rem' }}>
      <InputGroup>
        <InputGroup.Text>
          <Search size={16} aria-hidden="true" />
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

function NotificationBell({ user }) {
  const navigate = useNavigate()
  // Both from Settings > Notifications: whether to poll at all, and how
  // often. Turning it off stops the background request rather than just
  // hiding the dot.
  const { notificationsEnabled, notificationPollMinutes } = useTheme()
  const [unreadCount, setUnreadCount] = useState(0)
  const [mentions, setMentions] = useState([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!user || !notificationsEnabled) return undefined
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
    const intervalId = setInterval(fetchUnreadCount, notificationPollMinutes * 60000)
    return () => {
      cancelled = true
      clearInterval(intervalId)
    }
  }, [user, notificationsEnabled, notificationPollMinutes])

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
        as="button"
        type="button"
        className="icon-button position-relative dropdown-toggle-no-caret"
        id="notification-bell"
        aria-label="Notifications"
        // The red dot carries "unread" visually and can't be announced, so
        // the count rides along as a *description* -- the button's name
        // stays exactly "Notifications", which is what it has always been.
        aria-describedby={notificationsEnabled && unreadCount > 0 ? 'notification-unread-count' : undefined}
        title="Notifications"
      >
        <Bell size={18} aria-hidden="true" />
        {notificationsEnabled && unreadCount > 0 && (
          <>
            <span className="notification-dot" />
            <span id="notification-unread-count" className="visually-hidden">
              {unreadCount} unread
            </span>
          </>
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

export default function AppHeader({ user, theme, onToggleTheme }) {
  const { meta, setActionSlot } = usePageChrome()
  const location = useLocation()
  const title = meta?.title || routeTitle(location.pathname)
  const breadcrumbs = meta?.breadcrumbs ?? []

  return (
    <header className="app-header">
      <div className="me-auto" style={{ minWidth: 0 }}>
        <div className="d-flex align-items-center gap-2">
          <h1 className="app-header__title text-truncate">{title}</h1>
          {meta?.badge && <StatusPill tone="grey">{meta.badge}</StatusPill>}
        </div>
        {breadcrumbs.length > 0 && (
          <nav aria-label="Breadcrumb">
            <ol className="breadcrumb mb-0 small">
              {breadcrumbs.map((crumb, index) => (
                <li
                  key={`${crumb.label}-${index}`}
                  className={`breadcrumb-item ${crumb.to ? '' : 'active'}`.trim()}
                  aria-current={crumb.to ? undefined : 'page'}
                >
                  {crumb.to ? <Link to={crumb.to}>{crumb.label}</Link> : crumb.label}
                </li>
              ))}
            </ol>
          </nav>
        )}
      </div>

      {/* Where a page's own actions land (see PageActions). A ref callback,
          not an effect, so handing the node over doesn't cascade renders. */}
      <div className="app-header__actions" ref={setActionSlot} />

      <GlobalSearch />

      <button
        type="button"
        className="icon-button"
        onClick={onToggleTheme}
        aria-label={theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'}
        title={theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'}
      >
        {theme === 'light' ? <Moon size={18} aria-hidden="true" /> : <Sun size={18} aria-hidden="true" />}
      </button>

      <NotificationBell user={user} />
    </header>
  )
}
