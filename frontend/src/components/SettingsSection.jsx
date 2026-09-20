// A settings section: a heading with a line of muted text saying what the
// section is for, then rows whose label sits left and whose control sits
// right.
//
// The label is a real <label> pointing at its control, so the pairing is
// there for a screen reader too rather than being only a column of text
// beside a column of inputs.

export default function SettingsSection({ title, description, children }) {
  return (
    <section className="settings-section">
      <div className="settings-section__head">
        <h2 className="settings-section__title">{title}</h2>
        {description && <p className="settings-section__description">{description}</p>}
      </div>
      <div className="settings-section__rows">{children}</div>
    </section>
  )
}

export function SettingRow({ label, hint, htmlFor, children }) {
  return (
    <div className="setting-row">
      <div className="setting-row__label">
        {htmlFor ? (
          <label className="setting-row__title" htmlFor={htmlFor}>
            {label}
          </label>
        ) : (
          <span className="setting-row__title">{label}</span>
        )}
        {hint && <p className="setting-row__hint">{hint}</p>}
      </div>
      <div className="setting-row__control">{children}</div>
    </div>
  )
}

/**
 * A boolean as a switch. Bootstrap's own form-switch markup, with the label
 * supplied by the row rather than repeated beside the control.
 */
export function SettingToggle({ id, checked, onChange, label, disabled = false }) {
  return (
    <div className="form-check form-switch settings-toggle">
      <input
        className="form-check-input"
        type="checkbox"
        role="switch"
        id={id}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        // The visible label is the row's, off to the left; this names the
        // control itself for anyone who meets it on its own.
        aria-label={label}
      />
    </div>
  )
}

/**
 * A small set of mutually exclusive choices, as a row of buttons rather
 * than a select -- there are only ever three or four, and seeing them all
 * at once is the point.
 */
export function SettingChoice({ name, options, value, onChange, label }) {
  return (
    <div className="settings-choice" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          className={`settings-choice__option ${value === option.value ? 'settings-choice__option--active' : ''}`.trim()}
          onClick={() => onChange(option.value)}
          id={`${name}-${option.value}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
