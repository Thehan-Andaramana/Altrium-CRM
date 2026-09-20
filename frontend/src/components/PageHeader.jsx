import { usePageMeta } from './PageChrome.jsx'

// Shared detail-page header. The title, its status word and the breadcrumb
// trail are handed to the layout's header bar (see PageChrome) rather than
// drawn here -- what's left on the page itself is the subtitle and the
// record's actions.
//
// `badge` and `breadcrumbs` are plain data, not JSX: they cross into the
// header through a serialised context value.
export default function PageHeader({ title, badge = null, subtitle, breadcrumbs = null, actions }) {
  usePageMeta({ title, badge, breadcrumbs })

  if (!subtitle && !actions) {
    return null
  }

  return (
    <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
      {subtitle ? <p className="text-body-secondary mb-0">{subtitle}</p> : <span />}
      {actions && <div className="d-flex align-items-center gap-2 flex-shrink-0">{actions}</div>}
    </div>
  )
}
