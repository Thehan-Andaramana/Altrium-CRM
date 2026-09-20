import { useEffect, useState } from 'react'
import { Outlet, useNavigate } from 'react-router-dom'
import { get } from '../api'
import { useAuth } from '../AuthContext.jsx'
import { useTheme } from '../ThemeContext.jsx'
import AppHeader from './AppHeader.jsx'
import { PageChromeProvider } from './PageChrome.jsx'
import Sidebar from './Sidebar.jsx'
import { UserDirectoryProvider } from './UserDirectory.jsx'

export default function Layout() {
  const { user, logout } = useAuth()
  const { theme, setTheme, sidebarCollapsed, setSidebarCollapsed, notificationsEnabled, notificationPollMinutes } =
    useTheme()
  const navigate = useNavigate()

  // Both are "needs your attention" counts shown on sidebar items. Each
  // endpoint is already role-scoped server-side -- /api/approvals/ gives
  // management every pending request and a rep only their own, and
  // /api/calendar/ scopes a rep to their leads and a PM to their projects
  // -- so neither number needs filtering here.
  const [counts, setCounts] = useState({ approvals: 0, overdue: 0 })

  useEffect(() => {
    // The same Notifications preference the bell reads: the sidebar's
    // counts are background polling too, so they stop together.
    if (!user || !notificationsEnabled) {
      return undefined
    }
    let cancelled = false

    async function fetchCounts() {
      // One small response rather than the whole approvals list and a
      // month of calendar tasks -- see SidebarBadgeView.
      const badges = await get('/api/badges/').catch(() => null)
      if (cancelled || !badges) {
        // A failed fetch leaves the counts as they were rather than
        // flashing to zero -- the next poll self-corrects either way.
        return
      }
      setCounts({ approvals: badges.pending_approvals, overdue: badges.overdue_tasks })
    }

    fetchCounts()
    const intervalId = setInterval(fetchCounts, notificationPollMinutes * 60000)
    return () => {
      cancelled = true
      clearInterval(intervalId)
    }
  }, [user, notificationsEnabled, notificationPollMinutes])

  function toggleTheme() {
    setTheme(theme === 'light' ? 'dark' : 'light')
  }

  async function handleLogout() {
    await logout()
    navigate('/login', { replace: true })
  }

  return (
    <UserDirectoryProvider>
      <PageChromeProvider>
        <Sidebar
          user={user}
          counts={counts}
          collapsed={sidebarCollapsed}
          onToggleCollapsed={() => setSidebarCollapsed(!sidebarCollapsed)}
          onLogout={handleLogout}
        />
        <div className={`app-content ${sidebarCollapsed ? 'app-content--collapsed' : ''}`.trim()}>
          <AppHeader user={user} theme={theme} onToggleTheme={toggleTheme} />
          <main className="app-main">
            <Outlet />
          </main>
        </div>
      </PageChromeProvider>
    </UserDirectoryProvider>
  )
}
