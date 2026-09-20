import { User } from 'lucide-react'
import { useUserRole } from './UserDirectory.jsx'

// Initial avatar for a named person, coloured by their role.
//
// Deliberately aria-hidden: an avatar almost always sits next to the name it
// stands for, so announcing the initials as well would read the same person
// twice. It also means adding one to a table cell or a button leaves that
// element's accessible name exactly as it was. Where an avatar stands alone
// (the task rows on a lead), the caller supplies its own visually-hidden
// text -- see TaskRow.

const ROLE_MODIFIERS = {
  SALES_REP: 'sales-rep',
  PROJECT_MANAGER: 'project-manager',
  SALES_MANAGER: 'sales-manager',
  EXECUTIVE_MANAGER: 'executive-manager',
  SYSTEM_ADMIN: 'system-admin',
}

export const ROLE_LABELS = {
  SALES_REP: 'Sales Rep',
  SALES_MANAGER: 'Sales Manager',
  EXECUTIVE_MANAGER: 'Executive Manager',
  PROJECT_MANAGER: 'Project Manager',
  SYSTEM_ADMIN: 'System Admin',
}

function initialsFor(name) {
  if (!name) {
    return '?'
  }
  // "Ada Lovelace" -> "AL", "rep1" -> "RE": usernames in this app are
  // single tokens, real names are not, and both want two characters.
  const words = String(name).trim().split(/[\s._-]+/).filter(Boolean)
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase()
  }
  return String(name).slice(0, 2).toUpperCase()
}

/**
 * @param {string} name     who the avatar stands for
 * @param {string} [role]   their role, when the caller already knows it;
 *                          otherwise it's looked up by name (UserDirectory)
 */
export default function Avatar({ name, role, size, className = '', title }) {
  const lookedUpRole = useUserRole(role ? null : name)
  const modifier = ROLE_MODIFIERS[role ?? lookedUpRole]
  const sizeClass = size ? `avatar--${size}` : ''
  const roleClass = modifier ? `avatar--role-${modifier}` : ''

  return (
    <span
      className={`avatar ${sizeClass} ${roleClass} ${className}`.trim()}
      aria-hidden="true"
      title={title ?? name ?? undefined}
    >
      {initialsFor(name)}
    </span>
  )
}

/**
 * The same disc, for a slot nobody fills yet -- a dashed outline and a
 * person glyph rather than a "?", which reads as "who is this?" instead of
 * "nobody yet". aria-hidden like the others: the row that holds it says
 * "Unassigned" in text of its own.
 */
export function UnassignedAvatar({ size, title = 'Unassigned', className = '' }) {
  const sizeClass = size ? `avatar--${size}` : ''
  return (
    <span
      className={`avatar avatar--unassigned ${sizeClass} ${className}`.trim()}
      aria-hidden="true"
      title={title}
    >
      <User size={size === 'sm' ? 12 : 14} />
    </span>
  )
}

// A name with its avatar. `fallback` covers the "Unassigned" / "—" case,
// which gets no avatar at all -- there is no person to stand for.
export function PersonCell({ name, role, fallback = '—', size = 'sm', className = '' }) {
  if (!name) {
    return <span className="text-body-secondary">{fallback}</span>
  }
  return (
    <span className={`d-inline-flex align-items-center gap-2 ${className}`.trim()}>
      <Avatar name={name} role={role} size={size} />
      <span className="text-truncate">{name}</span>
    </span>
  )
}

// Overlapping avatars, for the rep/PM pair on a board card.
export function AvatarStack({ people, size = 'sm' }) {
  const named = people.filter(Boolean)
  if (named.length === 0) {
    return null
  }
  return (
    <span className="avatar-stack">
      {named.map((entry, index) => {
        const name = typeof entry === 'string' ? entry : entry.name
        const role = typeof entry === 'string' ? undefined : entry.role
        const title = typeof entry === 'string' ? name : entry.title ?? name
        return <Avatar key={`${name}-${index}`} name={name} role={role} size={size} title={title} />
      })}
    </span>
  )
}
