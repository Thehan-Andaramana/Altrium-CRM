// Initial avatar for a named person -- amber ground, ink initials (fixed
// contrast in both themes, like .btn-accent).
//
// Deliberately aria-hidden: an avatar always sits next to the name it
// stands for, so announcing the initials as well would just read the same
// person twice. It also means adding one to a table cell or a button leaves
// that element's accessible name exactly as it was.

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

export default function Avatar({ name, size, className = '' }) {
  const sizeClass = size ? `avatar--${size}` : ''
  return (
    <span className={`avatar ${sizeClass} ${className}`.trim()} aria-hidden="true" title={name || undefined}>
      {initialsFor(name)}
    </span>
  )
}

// A name with its avatar. `fallback` covers the "Unassigned" / "—" case,
// which gets no avatar at all -- there is no person to stand for.
export function PersonCell({ name, fallback = '—', size = 'sm', className = '' }) {
  if (!name) {
    return <span className="text-body-secondary">{fallback}</span>
  }
  return (
    <span className={`d-inline-flex align-items-center gap-2 ${className}`.trim()}>
      <Avatar name={name} size={size} />
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
      {named.map((name, index) => (
        <Avatar key={`${name}-${index}`} name={name} size={size} />
      ))}
    </span>
  )
}
