import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { get } from '../api'

// Avatars are coloured by the role of the person they stand for, but most
// places that draw one only ever receive a username -- `assigned_to_username`,
// `requested_by_username`, `owner_username` and so on. Rather than add a
// matching `*_role` to every serializer that carries a name, the username ->
// role map is fetched once here and shared.
//
// /api/users/ is readable by any authenticated user (see UserViewSet -- the
// @mention autocomplete needs it too), and it is a small, slow-changing list,
// so one fetch per session is enough.

const UserDirectoryContext = createContext(null)

export function UserDirectoryProvider({ children }) {
  const [rolesByUsername, setRolesByUsername] = useState(() => new Map())

  useEffect(() => {
    let cancelled = false

    async function fetchUsers() {
      try {
        const users = await get('/api/users/')
        if (!cancelled) {
          setRolesByUsername(new Map(users.map((user) => [user.username, user.role])))
        }
      } catch {
        // An avatar without a known role falls back to the neutral colour,
        // which is a cosmetic loss -- nothing here is worth failing a page
        // over, and there's no second chance needed: the next page load
        // tries again.
      }
    }

    fetchUsers()
    return () => {
      cancelled = true
    }
  }, [])

  const value = useMemo(
    () => ({ roleFor: (username) => (username ? rolesByUsername.get(username) ?? null : null) }),
    [rolesByUsername],
  )

  return <UserDirectoryContext.Provider value={value}>{children}</UserDirectoryContext.Provider>
}

/**
 * The role of a named user, or null if it isn't known (yet, or at all).
 * Deliberately tolerant of there being no provider, so an Avatar can be
 * rendered outside the authenticated layout without blowing up.
 */
export function useUserRole(username) {
  const context = useContext(UserDirectoryContext)
  return context ? context.roleFor(username) : null
}
