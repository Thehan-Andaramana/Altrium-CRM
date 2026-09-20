import { useEffect, useState } from 'react'
import { Outlet, useNavigate } from 'react-router-dom'
import { get } from '../api'
import { useAuth } from '../AuthContext.jsx'
import { useTheme } from '../ThemeContext.jsx'
import AppHeader from './AppHeader.jsx'
import { PageChromeProvider } from './PageChrome.jsx'
import Sidebar from './Sidebar.jsx'

// How often the sidebar's count badges are refreshed. The same cadence the
// notification bell already polls at, so the chrome updates as one.
const COUNT_POLL_MS = 60000

export default function Layout() {
  const { user, logout } = useAuth()
  const { theme, setTheme, sidebarCollapsed, setSidebarCollapsed } = useTheme()
  const navigate = useNavigate()

  // Both are "needs your attention" counts shown on sidebar items. Each
  // endpoint is already role-scoped server-side -- /api/approvals/ gives
  // management every pending request and a rep only their own, and
  // /api/calendar/ scopes a rep to their leads and a PM to their projects
  // -- so neither number needs filtering here.
  const [counts, setCounts] = useState({ approvals: 0, overdue: 0 })

  useEffect(() => {
    if (!user) {
      return
    }
    let cancelled = false

    async function fetchCounts() {
      const [approvals, calendarTasks] = await Promise.all([
        get('/api/approvals/?status=PENDING').catch(() => null),
        get('/api/calendar/').catch(() => null),
      ])
      if (cancelled) {
        return
      }
      // A failed fetch leaves that count as it was rather than flashing to
      // zero -- the next poll self-corrects either way.
      setCounts((previous) => ({
        approvals: approvals ? approvals.length : previous.approvals,
        overdue: calendarTasks
          ? calendarTasks.filter((task) => task.calendar_status === 'OVERDUE').length
          : previous.overdue,
      }))
    }

    fetchCounts()
    const intervalId = setInterval(fetchCounts, COUNT_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(intervalId)
    }
  }, [user])

  function toggleTheme() {
    setTheme(theme === 'light' ? 'dark' : 'light')
  }

  async function handleLogout() {
    await logout()
    navigate('/login', { replace: true })
  }

  return (
    <PageChromeProvider>
      <Sidebar
        user={user}
        counts={counts}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={() => setSidebarCollapsed(!sidebarCollapsed)}
      />
      <div className={`app-content ${sidebarCollapsed ? 'app-content--collapsed' : ''}`.trim()}>
        <AppHeader user={user} theme={theme} onToggleTheme={toggleTheme} onLogout={handleLogout} />
        <main className="app-main">
          <Outlet />
        </main>
      </div>
    </PageChromeProvider>
  )
}
