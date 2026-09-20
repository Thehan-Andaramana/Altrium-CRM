import { ChevronDown, ChevronsUpDown, ChevronUp } from 'lucide-react'
import { useMemo, useState } from 'react'

// Client-side column sorting for the card-row tables. Purely a view
// concern: it reorders the rows already on screen and issues no request, so
// the server's own ordering stays the default until a header is clicked.

function isEmpty(value) {
  return value === null || value === undefined || value === ''
}

function compareValues(a, b) {
  if (typeof a === 'number' && typeof b === 'number') {
    return a - b
  }
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
}

/**
 * `accessors` maps a column key to a function pulling that column's sort
 * value out of a row. Returns the sorted rows plus the props each sortable
 * header needs.
 */
export function useSortedRows(rows, accessors) {
  const [sort, setSort] = useState(null)

  const sorted = useMemo(() => {
    if (!sort || !accessors[sort.key]) {
      return rows
    }
    const accessor = accessors[sort.key]
    const direction = sort.direction === 'descending' ? -1 : 1
    // Decorate-sort-undecorate: the accessor runs once per row rather than
    // once per comparison. Copied first -- `rows` is state owned by the
    // page, and Array#sort is in place.
    return rows
      .map((row, index) => ({ row, index, value: accessor(row) }))
      .sort((a, b) => {
        // Empty cells sort last in *both* directions -- absent data isn't a
        // value that belongs at one end of the range -- so the flip below
        // deliberately doesn't apply to them.
        if (isEmpty(a.value) || isEmpty(b.value)) {
          if (isEmpty(a.value) && isEmpty(b.value)) return a.index - b.index
          return isEmpty(a.value) ? 1 : -1
        }
        const result = compareValues(a.value, b.value)
        // Ties keep their original (server-ordered) relative position.
        return result === 0 ? a.index - b.index : result * direction
      })
      .map((entry) => entry.row)
  }, [rows, sort, accessors])

  function toggle(key) {
    setSort((previous) => {
      if (!previous || previous.key !== key) {
        return { key, direction: 'ascending' }
      }
      return previous.direction === 'ascending'
        ? { key, direction: 'descending' }
        : null
    })
  }

  // setSort is for controls that name a direction outright (the pipeline's
  // sort chips); toggle is for a column header, which cycles.
  return { rows: sorted, sort, setSort, toggle }
}

const SORT_ICON = {
  ascending: ChevronUp,
  descending: ChevronDown,
}

/**
 * A sortable column header. The <th> carries aria-sort (the property
 * assistive tech reads for sort state) and the button inside it is what
 * takes the click, so the column stays reachable by keyboard.
 */
export function SortableTh({ columnKey, label, sort, onToggle, className = '' }) {
  const active = sort?.key === columnKey
  const direction = active ? sort.direction : 'none'
  const Icon = SORT_ICON[direction] ?? ChevronsUpDown

  return (
    <th scope="col" aria-sort={direction} className={className}>
      <button
        type="button"
        className="table-sort-button"
        // aria-sort belongs on the column header, not on the control inside
        // it; this mirror is a styling hook only.
        data-sort={direction}
        onClick={() => onToggle(columnKey)}
      >
        {label}
        <Icon size={12} className="table-sort-icon" aria-hidden="true" />
      </button>
    </th>
  )
}

// Non-sortable header, so a table's columns stay visually consistent.
export function PlainTh({ label, className = '' }) {
  return (
    <th scope="col" className={className}>
      {label}
    </th>
  )
}
