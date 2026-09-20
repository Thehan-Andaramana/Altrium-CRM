// A single-series column chart -- average days per phase, and anything else
// shaped like "one number per named bucket".
//
// One series means one hue for every bar (never a colour per bar: bar
// height already encodes the value, and spending the identity channel on it
// twice just implies a distinction that isn't there) and no legend, since
// the caption names the series.

const WIDTH = 640
const HEIGHT = 200
const PADDING = { top: 16, right: 8, bottom: 34, left: 40 }
const BAR_GAP = 16
// Thin marks: a bar wider than this stops reading as a measurement and
// starts reading as a block of colour, however much room the slot allows.
const MAX_BAR_WIDTH = 48

function niceCeiling(value) {
  if (value <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(value))
  return Math.ceil(value / magnitude) * magnitude
}

export default function BarChart({ bars, caption, valueSuffix = '', emptyMessage = 'No data in range.' }) {
  const values = bars.map((bar) => bar.value ?? 0)
  const withData = bars.filter((bar) => bar.value != null)
  if (withData.length === 0) {
    return <p className="text-body-secondary small mb-0">{emptyMessage}</p>
  }

  const max = niceCeiling(Math.max(...values, 0))
  const plotWidth = WIDTH - PADDING.left - PADDING.right
  const plotHeight = HEIGHT - PADDING.top - PADDING.bottom
  const slot = plotWidth / bars.length
  const barWidth = Math.min(Math.max(slot - BAR_GAP, 8), MAX_BAR_WIDTH)
  // Three gridlines is enough to read a value off; more and the grid starts
  // competing with the bars it's meant to support.
  const ticks = [0, max / 2, max]

  return (
    <figure className="chart mb-0">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        width="100%"
        height={HEIGHT}
        role="img"
        aria-label={caption}
        preserveAspectRatio="xMinYMin meet"
      >
        {ticks.map((tick) => {
          const y = PADDING.top + plotHeight - (tick / max) * plotHeight
          return (
            <g key={tick}>
              <line x1={PADDING.left} x2={WIDTH - PADDING.right} y1={y} y2={y} className="chart-grid" />
              <text x={PADDING.left - 8} y={y + 4} className="chart-axis" textAnchor="end">
                {Math.round(tick * 10) / 10}
              </text>
            </g>
          )
        })}

        {bars.map((bar, index) => {
          const value = bar.value ?? 0
          const barHeight = max > 0 ? (value / max) * plotHeight : 0
          const x = PADDING.left + index * slot + (slot - barWidth) / 2
          const y = PADDING.top + plotHeight - barHeight
          return (
            <g key={bar.label}>
              <title>{`${bar.label}: ${bar.value ?? '—'}${valueSuffix}`}</title>
              {bar.value != null && barHeight > 0 && (
                <rect x={x} y={y} width={barWidth} height={barHeight} rx="4" fill="var(--chart-series-1)" />
              )}
              <text x={x + barWidth / 2} y={y - 6} className="chart-value" textAnchor="middle">
                {bar.value == null ? '—' : bar.value}
              </text>
              <text
                x={x + barWidth / 2}
                y={HEIGHT - PADDING.bottom + 18}
                className="chart-label"
                textAnchor="middle"
              >
                {bar.label}
              </text>
            </g>
          )
        })}
      </svg>
    </figure>
  )
}
