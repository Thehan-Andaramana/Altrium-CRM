import { createContext, useContext, useEffect, useState } from 'react'

const ThemeContext = createContext(undefined)

const STORAGE_KEY = 'app-preferences'
const FONT_SIZES = ['small', 'medium', 'large']
const DENSITIES = ['comfortable', 'compact']
const NAV_VARIANTS = ['top', 'sidebar']
const CARD_STYLES = ['elevated', 'flat', 'bordered']
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
      navVariant: 'top',
      cardStyle: 'elevated',
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
    navVariant: NAV_VARIANTS.includes(stored.navVariant) ? stored.navVariant : 'top',
    cardStyle: CARD_STYLES.includes(stored.cardStyle) ? stored.cardStyle : 'elevated',
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
    navVariant: preferences.navVariant,
    cardStyle: preferences.cardStyle,
    setTheme: (theme) => setPreferences((prev) => ({ ...prev, theme })),
    setFontSize: (fontSize) => setPreferences((prev) => ({ ...prev, fontSize })),
    setDensity: (density) => setPreferences((prev) => ({ ...prev, density })),
    setNavVariant: (navVariant) => setPreferences((prev) => ({ ...prev, navVariant })),
    setCardStyle: (cardStyle) => setPreferences((prev) => ({ ...prev, cardStyle })),
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
