// One entry on a lead's activity timeline: a coloured icon in a circle on
// the left, and the entry itself in a bordered card whose header carries
// who did it and when, with the content beneath.
//
// The icon's colour is a category signal, never the only one -- the header
// always names the kind of entry in words as well.

export default function TimelineEntry({ icon: Icon, tone = 'grey', title, meta, timestamp, children }) {
  return (
    <li className="timeline__entry">
      <span className={`timeline__icon timeline__icon--${tone}`} aria-hidden="true">
        <Icon size={16} />
      </span>
      <div className="timeline__card">
        <div className="timeline__header">
          <span className="timeline__title">{title}</span>
          {timestamp && <span className="timeline__time">{timestamp}</span>}
        </div>
        {meta && <div className="timeline__meta">{meta}</div>}
        {children && <div className="timeline__body">{children}</div>}
      </div>
    </li>
  )
}

export function Timeline({ children }) {
  return <ol className="timeline">{children}</ol>
}
