import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'

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
  // The header's action slot, captured as a DOM node by a ref callback so a
  // page can portal its buttons into it. A node rather than a React element
  // deliberately: JSX crossing a context would be a new value every render,
  // and the only ways to hold it would be an effect that sets state (which
  // cascades renders) or a serialisation that JSX can't survive.
  const [actionSlot, setActionSlot] = useState(null)
  const value = useMemo(() => ({ meta, setMeta, actionSlot, setActionSlot }), [meta, actionSlot])
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

/**
 * Renders its children into the header bar, right-aligned beside the page
 * title -- for actions that belong to the record the page is about rather
 * than to any one section of it.
 *
 * Renders nothing until the header has handed over its slot, which happens
 * on the header's first commit, so at worst the actions appear a frame late.
 */
export function PageActions({ children }) {
  const { actionSlot } = usePageChrome()
  return actionSlot ? createPortal(children, actionSlot) : null
}
