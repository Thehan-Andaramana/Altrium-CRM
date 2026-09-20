// Status pill: a leading dot and a tinted background, rather than a solid
// Bootstrap badge fill.
//
// The dot is an empty aria-hidden span, so the element's text content stays
// exactly the status word -- which matters because some of these pills are
// buttons (the lead status on LeadDetail), and the text *is* their
// accessible name.

// Lead temperature: HOT amber, COLD grey.
export const LEAD_STATUS_TONE = {
  HOT: 'amber',
  COLD: 'grey',
}

// Phase and approval statuses keep the colours they already had, just
// rendered as a tint instead of a fill.
export const PHASE_STATUS_TONE = {
  NOT_STARTED: 'grey',
  IN_PROGRESS: 'blue',
  AWAITING_APPROVAL: 'amber',
  COMPLETE: 'green',
}

export const APPROVAL_STATUS_TONE = {
  PENDING: 'amber',
  APPROVED: 'green',
  REJECTED: 'red',
}

export default function StatusPill({ tone = 'grey', children, className = '', as = 'span', ...props }) {
  const Tag = as
  return (
    <Tag className={`status-pill status-pill--${tone} ${className}`.trim()} {...props}>
      <span className="status-pill__dot" aria-hidden="true" />
      {children}
    </Tag>
  )
}
