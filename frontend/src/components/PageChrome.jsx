import { createContext, useContext, useEffect, useMemo, useState } from 'react'

// The page title now lives in the layout's header bar rather than in each
// page's body, so a page tells the layout what to put there instead of
// rendering its own <h1>. There is still exactly one <h1> per page -- it
// just belongs to the header now.
//
// Only serialisable values cross this boundary (strings and plain arrays),
// never JSX: the effect below keys off JSON.stringify, and a React node
// would be a fresh object on every render and loop forever.

const PageChromeContext = createContext(null)

export function PageChromeProvider({ children }) {
  const [meta, setMeta] = useState(null)
  const value = useMemo(() => ({ meta, setMeta }), [meta])
  return <PageChromeContext.Provider value={value}>{children}</PageChromeContext.Provider>
}

export function usePageChrome() {
  const context = useContext(PageChromeContext)
  if (!context) {
    throw new Error('usePageChrome must be used within a PageChromeProvider')
  }
  return context
}

/**
 * Sets the header bar's title for as long as the calling page is mounted.
 *
 * @param {object} meta
 * @param {string} meta.title        the <h1> text
 * @param {string} [meta.badge]      short status word shown beside the title
 * @param {Array<{label: string, to?: string}>} [meta.breadcrumbs]
 *        the trail under the title on a detail page; an entry without `to`
 *        renders as plain text (the current record).
 */
export function usePageMeta({ title, badge = null, breadcrumbs = null }) {
  const { setMeta } = usePageChrome()
  const serialised = JSON.stringify({ title, badge, breadcrumbs })

  useEffect(() => {
    setMeta(JSON.parse(serialised))
    // Cleared on unmount so the next page's own title (or the route
    // fallback, while that page is still loading) takes over cleanly.
    return () => setMeta(null)
  }, [serialised, setMeta])
}
