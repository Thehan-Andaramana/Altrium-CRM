import { Link } from 'react-router-dom'

// Dashboard stat card: icon top-left, then a large number over a small
// muted label. `to` makes the whole card a link through to the list the
// number came from.
export default function StatCard({ label, value, Icon, tone = 'grey', to }) {
  const body = (
    <>
      <span className={`stat-card__icon stat-card__icon--${tone}`}>
        <Icon size={18} aria-hidden="true" />
      </span>
      <span>
        <span className="stat-card__value d-block">{value}</span>
        <span className="stat-card__label">{label}</span>
      </span>
    </>
  )

  if (!to) {
    return <div className="stat-card">{body}</div>
  }

  // The label alone names the destination ("Hot Leads"), so the link needs
  // no extra accessible name -- but the count reads first without one.
  return (
    <Link to={to} className="stat-card text-decoration-none text-body" aria-label={`${label}: ${value}`}>
      {body}
    </Link>
  )
}
