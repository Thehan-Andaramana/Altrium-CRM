import { Check, Copy, Mail, Phone } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

// Email and phone are the two things anyone actually does something with on
// a contact, so they get their own row: an icon, the value as a link that
// opens the right app (mailto:/tel:), and a copy button for the times you
// want the value somewhere else instead.

const COPIED_FEEDBACK_MS = 1600

function CopyButton({ value, label }) {
  const [copied, setCopied] = useState(false)
  const timeout = useRef(null)

  useEffect(() => () => clearTimeout(timeout.current), [])

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      clearTimeout(timeout.current)
      timeout.current = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS)
    } catch {
      // Clipboard access can be refused (an insecure origin, or the user
      // denying permission). Nothing useful to say beyond "it didn't
      // happen", and the value is right there to select by hand.
    }
  }

  return (
    <button
      type="button"
      className="icon-button icon-button--sm"
      onClick={handleCopy}
      // The name stays put while the icon changes, so the button doesn't
      // rename itself under a screen reader mid-interaction.
      aria-label={label}
      title={copied ? 'Copied' : label}
    >
      {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      <span className="visually-hidden" role="status">
        {copied ? 'Copied' : ''}
      </span>
    </button>
  )
}

function DetailRow({ Icon, href, value, copyLabel, className = '' }) {
  return (
    <div className={`contact-detail ${className}`.trim()}>
      <Icon size={16} className="contact-detail__icon" aria-hidden="true" />
      <a href={href} className="contact-detail__value">
        {value}
      </a>
      <CopyButton value={value} label={copyLabel} />
    </div>
  )
}

/**
 * Email and phone for one person. Renders nothing when they have neither.
 *
 * @param {string} [name] whose details these are -- used to tell one copy
 *                        button from another when several contacts are listed
 */
export default function ContactDetails({ email, phone, name, className = '' }) {
  if (!email && !phone) {
    return null
  }
  const suffix = name ? ` for ${name}` : ''

  return (
    <div className={`contact-details ${className}`.trim()}>
      {email && (
        <DetailRow
          Icon={Mail}
          href={`mailto:${email}`}
          value={email}
          copyLabel={`Copy email address${suffix}`}
        />
      )}
      {phone && (
        <DetailRow
          Icon={Phone}
          // Spaces and punctuation are fine to display but not to dial.
          href={`tel:${phone.replace(/[^+\d]/g, '')}`}
          value={phone}
          copyLabel={`Copy phone number${suffix}`}
        />
      )}
    </div>
  )
}
