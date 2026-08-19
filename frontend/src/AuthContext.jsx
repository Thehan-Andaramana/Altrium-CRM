import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { get, post } from './api'

const AuthContext = createContext(undefined)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    async function restoreSession() {
      try {
        await get('/api/auth/csrf/')
        const me = await get('/api/auth/me/')
        if (!cancelled) setUser(me)
      } catch {
        if (!cancelled) setUser(null)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    restoreSession()
    return () => {
      cancelled = true
    }
  }, [])

  const login = useCallback(async (username, password) => {
    const me = await post('/api/auth/login/', { username, password })
    setUser(me)
    return me
  }, [])

  const logout = useCallback(async () => {
    await post('/api/auth/logout/')
    setUser(null)
  }, [])

  const value = { user, loading, login, logout }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}