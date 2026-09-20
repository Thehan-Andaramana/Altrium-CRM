import { ChevronDown } from 'lucide-react'
import { useState } from 'react'

// The pipeline's filter rail: a row of sort chips, then collapsible groups
// of checkboxes.
//
// Everything here is a real control -- a chip is a button with
// aria-pressed, a group header is a button with aria-expanded, and each
// option is a checkbox with its own label -- so the rail is usable from the
// keyboard and announces its own state rather than relying on the styling.

export function SortChips({ options, value, onChange, label = 'Sort by' }) {
  return (
    <div className="filter-panel__sort">
      <div className="filter-panel__sort-label">{label}</div>
      <div className="filter-panel__chips" role="group" aria-label={label}>
        {options.map((option) => {
          const active = value === option.value
          return (
            <button
              key={option.value}
              type="button"
              className={`filter-chip ${active ? 'filter-chip--active' : ''}`.trim()}
              aria-pressed={active}
              // Clicking the active chip clears the sort rather than doing
              // nothing -- otherwise there is no way back to the server's
              // own order once a chip is chosen.
              onClick={() => onChange(active ? null : option.value)}
            >
              {option.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

export function FilterGroup({ title, defaultOpen = true, children }) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div className="filter-group">
      <button
        type="button"
        className="filter-group__header"
        aria-expanded={open}
        onClick={() => setOpen((previous) => !previous)}
      >
        <span>{title}</span>
        <ChevronDown
          size={16}
          className={`filter-group__chevron ${open ? 'filter-group__chevron--open' : ''}`.trim()}
          aria-hidden="true"
        />
      </button>
      {open && <div className="filter-group__body">{children}</div>}
    </div>
  )
}

/**
 * A checkbox list where an empty selection means "everything" -- the same
 * thing an all-checked list would mean, without making the user tick five
 * boxes to see the default view.
 */
export function FilterOptions({ name, options, selected, onChange, emptyMessage = 'Nothing to filter on.' }) {
  if (options.length === 0) {
    return <p className="text-body-secondary small mb-0">{emptyMessage}</p>
  }

  function toggle(value) {
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value])
  }

  return (
    <div className="filter-group__options">
      {options.map((option) => (
        <div className="form-check" key={option.value}>
          <input
            className="form-check-input"
            type="checkbox"
            id={`${name}-${option.value}`}
            checked={selected.includes(option.value)}
            onChange={() => toggle(option.value)}
          />
          <label className="form-check-label" htmlFor={`${name}-${option.value}`}>
            {option.label}
            {option.count != null && <span className="filter-group__count">{option.count}</span>}
          </label>
        </div>
      ))}
    </div>
  )
}

export default function FilterPanel({ title = 'Filter', onReset, canReset, children }) {
  return (
    <aside className="filter-panel" aria-label={title}>
      <div className="filter-panel__head">
        <h2 className="filter-panel__title">{title}</h2>
        {canReset && (
          <button type="button" className="filter-panel__reset" onClick={onReset}>
            Reset
          </button>
        )}
      </div>
      {children}
    </aside>
  )
}
