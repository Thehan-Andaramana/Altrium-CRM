// Shared page-header row: title (with an optional inline badge and a
// secondary subtitle line) on the left, actions on the right, bottom-bordered.
export default function PageHeader({ title, badge, subtitle, actions }) {
  return (
    <div className="pb-3 mb-4 border-bottom">
      <div className="d-flex flex-wrap justify-content-between align-items-center gap-2">
        <h1 className="h3 mb-0">
          {title}
          {badge && (
            <span className="ms-2 align-middle">{badge}</span>
          )}
        </h1>
        {actions && <div className="d-flex align-items-center gap-2 flex-shrink-0">{actions}</div>}
      </div>
      {subtitle && <p className="text-body-secondary mb-0 mt-1">{subtitle}</p>}
    </div>
  )
}
