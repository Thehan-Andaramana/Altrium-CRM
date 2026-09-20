import { createContext, useContext, useEffect, useState } from 'react'

const ThemeContext = createContext(undefined)

const STORAGE_KEY = 'app-preferences'
const FONT_SIZES = ['small', 'medium', 'large']
const DENSITIES = ['comfortable', 'compact']
// The top-navbar layout is gone -- the app is sidebar-only now -- so what
// used to be a choice of navigation *style* is now a choice of the
// sidebar's default width: the full 260px panel or the 72px icon rail.
// Preferences stored under the old NAV_VARIANTS values ('top'/'sidebar')
// simply fall through to the default below.
const CARD_STYLES = ['elevated', 'flat', 'bordered']
// How often the notification bell and the sidebar's count badges re-poll.
// "off" stops both, for anyone who would rather not have the page talking
// to the server in the background at all.
const POLL_MINUTES = [1, 5, 15]
const FONT_SCALES = { small: 0.875, medium: 1, large: 1.125 }
const CARD_STYLE_CLASSES = CARD_STYLES.map((style) => `card-style-${style}`)

function getSystemTheme() {
  if (typeof window === 'undefined' || !window.matchMedia) return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function loadPreferences() {
  if (typeof window === 'undefined') {
    return {
      theme: 'light',
      fontSize: 'medium',
      density: 'comfortable',
      sidebarCollapsed: false,
      cardStyle: 'elevated',
      notificationsEnabled: true,
      notificationPollMinutes: 1,
    }
  }
  let stored = {}
  try {
    stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}')
  } catch {
    stored = {}
  }
  return {
    theme: stored.theme === 'light' || stored.theme === 'dark' ? stored.theme : getSystemTheme(),
    fontSize: FONT_SIZES.includes(stored.fontSize) ? stored.fontSize : 'medium',
    density: DENSITIES.includes(stored.density) ? stored.density : 'comfortable',
    sidebarCollapsed: stored.sidebarCollapsed === true,
    cardStyle: CARD_STYLES.includes(stored.cardStyle) ? stored.cardStyle : 'elevated',
    notificationsEnabled: stored.notificationsEnabled !== false,
    notificationPollMinutes: POLL_MINUTES.includes(stored.notificationPollMinutes)
      ? stored.notificationPollMinutes
      : 1,
  }
}

export function ThemeProvider({ children }) {
  const [preferences, setPreferences] = useState(loadPreferences)

  useEffect(() => {
    document.documentElement.setAttribute('data-bs-theme', preferences.theme)
  }, [preferences.theme])

  useEffect(() => {
    document.documentElement.style.setProperty(
      '--app-font-scale',
      String(FONT_SCALES[preferences.fontSize]),
    )
  }, [preferences.fontSize])

  useEffect(() => {
    document.documentElement.setAttribute('data-density', preferences.density)
  }, [preferences.density])

  useEffect(() => {
    document.documentElement.classList.remove(...CARD_STYLE_CLASSES)
    document.documentElement.classList.add(`card-style-${preferences.cardStyle}`)
  }, [preferences.cardStyle])

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences))
  }, [preferences])

  const value = {
    theme: preferences.theme,
    fontSize: preferences.fontSize,
    density: preferences.density,
    sidebarCollapsed: preferences.sidebarCollapsed,
    cardStyle: preferences.cardStyle,
    notificationsEnabled: preferences.notificationsEnabled,
    notificationPollMinutes: preferences.notificationPollMinutes,
    setTheme: (theme) => setPreferences((prev) => ({ ...prev, theme })),
    setFontSize: (fontSize) => setPreferences((prev) => ({ ...prev, fontSize })),
    setDensity: (density) => setPreferences((prev) => ({ ...prev, density })),
    setSidebarCollapsed: (sidebarCollapsed) => setPreferences((prev) => ({ ...prev, sidebarCollapsed })),
    setCardStyle: (cardStyle) => setPreferences((prev) => ({ ...prev, cardStyle })),
    setNotificationsEnabled: (notificationsEnabled) =>
      setPreferences((prev) => ({ ...prev, notificationsEnabled })),
    setNotificationPollMinutes: (notificationPollMinutes) =>
      setPreferences((prev) => ({ ...prev, notificationPollMinutes })),
  }

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const context = useContext(ThemeContext)
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider')
  }
  return context
}
