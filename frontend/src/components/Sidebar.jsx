import {
  BarChart3,
  Building2,
  CalendarDays,
  CheckSquare,
  ChevronsLeft,
  ChevronsRight,
  ChevronUp,
  FileText,
  GitBranch,
  Kanban,
  LayoutDashboard,
  LogOut,
  Settings,
  SlidersHorizontal,
  Users,
} from 'lucide-react'
import Dropdown from 'react-bootstrap/Dropdown'
import { Link, NavLink, useLocation } from 'react-router-dom'
import Avatar, { ROLE_LABELS } from './Avatar.jsx'
import BrandMark from './BrandMark.jsx'

const MANAGEMENT_ROLES = new Set(['SALES_MANAGER', 'EXECUTIVE_MANAGER', 'SYSTEM_ADMIN'])

// Grouped nav. `visible` gates an item by role -- the same gating the
// routes and the API already apply, so the sidebar never offers a
// destination that would just bounce the user back.
//
// `badge` names which count (from the counts prop) rides the item, and
// `badgeAction` says whether that count means "you need to act on this"
// (amber) or is just a tally (muted).
const NAV_GROUPS = [
  {
    label: 'Main',
    items: [
      { to: '/', end: true, label: 'Dashboard', Icon: LayoutDashboard },
      { to: '/board', label: 'Board', Icon: Kanban },
      { to: '/leads', label: 'Pipeline', Icon: GitBranch },
      { to: '/calendar', label: 'Calendar', Icon: CalendarDays, badge: 'overdue' },
    ],
  },
  {
    label: 'Records',
    items: [
      { to: '/companies', label: 'Companies', Icon: Building2, visible: (user) => canSeeCompanies(user) },
      { to: '/contacts', label: 'Contacts', Icon: Users },
    ],
  },
  {
    label: 'Insights',
    items: [
      { to: '/reports', label: 'Reports', Icon: BarChart3, visible: isManagement },
    ],
  },
  {
    label: 'Workflow',
    items: [
      { to: '/approvals', label: 'Approvals', Icon: CheckSquare, badge: 'approvals', badgeAction: true },
      {
        to: '/settings?tab=templates',
        label: 'Templates',
        Icon: FileText,
        visible: isManagement,
        // Templates and System Settings are two tabs of one route, so
        // which is "current" is the query string's business, not the
        // pathname's -- NavLink's own isActive ignores search entirely.
        isActive: (location) => location.pathname === '/settings' && location.search.includes('tab=templates'),
      },
    ],
  },
  {
    label: 'Settings',
    items: [
      { to: '/preferences', label: 'Preferences', Icon: Settings },
      {
        to: '/settings',
        label: 'System Settings',
        Icon: SlidersHorizontal,
        visible: isManagement,
        isActive: (location) => location.pathname === '/settings' && !location.search.includes('tab=templates'),
      },
    ],
  },
]

function isManagement(user) {
  return Boolean(user) && MANAGEMENT_ROLES.has(user.role)
}

function canSeeCompanies(user) {
  return isManagement(user) || user?.role === 'SALES_REP'
}

function NavItem({ item, collapsed, count }) {
  const location = useLocation()
  const { to, end, label, Icon, badge, badgeAction } = item
  const forcedActive = item.isActive ? item.isActive(location) : null

  return (
    <NavLink
      to={to}
      end={end}
      // Collapsed to a rail the label is gone, so the accessible name has
      // to come from somewhere -- and the title gives sighted users the
      // same information on hover.
      aria-label={collapsed ? label : undefined}
      title={collapsed ? label : undefined}
      className={({ isActive }) =>
        ['app-sidebar__link', (forcedActive ?? isActive) ? 'active' : ''].join(' ').trim()
      }
    >
      <Icon size={18} aria-hidden="true" />
      {!collapsed && <span className="app-sidebar__label">{label}</span>}
      {badge && count > 0 && (
        <span className={`app-sidebar__count ${badgeAction ? 'app-sidebar__count--action' : ''}`.trim()}>
          {count > 99 ? '99+' : count}
        </span>
      )}
    </NavLink>
  )
}

export default function Sidebar({ user, counts, collapsed, onToggleCollapsed, onLogout }) {
  return (
    <nav
      className={`app-sidebar ${collapsed ? 'app-sidebar--collapsed' : ''}`.trim()}
      aria-label="Main navigation"
    >
      <div className="d-flex align-items-center justify-content-between">
        <Link to="/" className="app-sidebar__brand">
          <BrandMark />
          {!collapsed && <span>Altrium</span>}
        </Link>
        {!collapsed && (
          <button
            type="button"
            className="app-sidebar__collapse-toggle"
            onClick={onToggleCollapsed}
            aria-label="Collapse sidebar"
            title="Collapse sidebar"
          >
            <ChevronsLeft size={18} aria-hidden="true" />
          </button>
        )}
      </div>

      {collapsed && (
        <button
          type="button"
          className="app-sidebar__collapse-toggle mt-2 w-100"
          onClick={onToggleCollapsed}
          aria-label="Expand sidebar"
          title="Expand sidebar"
        >
          <ChevronsRight size={18} aria-hidden="true" />
        </button>
      )}

      <div className="app-sidebar__nav mt-2">
        {NAV_GROUPS.map((group) => {
          const items = group.items.filter((item) => !item.visible || item.visible(user))
          if (items.length === 0) {
            return null
          }
          return (
            <div key={group.label}>
              <div className="app-sidebar__section-label" aria-hidden="true">
                {group.label}
              </div>
              {items.map((item) => (
                <NavItem key={item.to} item={item} collapsed={collapsed} count={counts[item.badge] ?? 0} />
              ))}
            </div>
          )
        })}
      </div>

      {/* The app's single identity control: who you are, and the account
          menu. It used to be duplicated in the header bar. */}
      <div className="app-sidebar__footer">
        <Dropdown align="start" drop="up">
          <Dropdown.Toggle
            as="button"
            type="button"
            className="app-sidebar__user dropdown-toggle-no-caret"
            id="sidebar-user-menu"
            aria-label={`Account: ${user?.username ?? ''}`}
          >
            <Avatar name={user?.username} role={user?.role} />
            {!collapsed && (
              <>
                <span className="d-flex flex-column lh-sm overflow-hidden">
                  <span className="text-truncate">{user?.username}</span>
                  <span className="app-sidebar__user-role text-truncate">
                    {ROLE_LABELS[user?.role] ?? user?.role}
                  </span>
                </span>
                <ChevronUp size={16} aria-hidden="true" className="ms-auto flex-shrink-0" />
              </>
            )}
          </Dropdown.Toggle>
          <Dropdown.Menu>
            <Dropdown.Item as={Link} to="/preferences">
              <Settings size={16} className="me-2" aria-hidden="true" />
              Preferences
            </Dropdown.Item>
            {isManagement(user) && (
              <Dropdown.Item as={Link} to="/settings">
                <SlidersHorizontal size={16} className="me-2" aria-hidden="true" />
                System Settings
              </Dropdown.Item>
            )}
            <Dropdown.Divider />
            <Dropdown.Item as="button" type="button" onClick={onLogout} className="text-danger">
              <LogOut size={16} className="me-2" aria-hidden="true" />
              Logout
            </Dropdown.Item>
          </Dropdown.Menu>
        </Dropdown>
      </div>
    </nav>
  )
}
