// Projects per phase, as a stage-ordered horizontal bar chart.
//
// The phases are an *ordinal* scale -- swapping two of them would change
// what the chart means -- so the colour is one hue in monotone lightness
// steps rather than five identities, and the reader sees the order in the
// ramp. The ramp's anchor flips in dark mode (later stages get lighter, not
// darker), which is why there are two lists rather than one.
//
// Hand-built SVG on purpose: the codebase already draws its own icons
// inline, and three charts don't justify a charting dependency.

const ROW_HEIGHT = 34
const BAR_HEIGHT = 18
const LABEL_WIDTH = 150
const VALUE_WIDTH = 56
const WIDTH = 640

export default function Funnel({ stages, caption }) {
  const max = Math.max(...stages.map((stage) => stage.count), 1)
  const trackWidth = WIDTH - LABEL_WIDTH - VALUE_WIDTH
  const height = stages.length * ROW_HEIGHT

  return (
    <figure className="chart mb-0">
      <svg
        viewBox={`0 0 ${WIDTH} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label={caption}
        preserveAspectRatio="xMinYMin meet"
      >
        {stages.map((stage, index) => {
          const y = index * ROW_HEIGHT
          const barWidth = Math.max((stage.count / max) * trackWidth, stage.count > 0 ? 3 : 0)
          return (
            <g key={stage.label}>
              {/* The native SVG tooltip: the hover layer this chart needs,
                  without a second rendering path to keep in step. */}
              <title>{`${stage.label}: ${stage.count}`}</title>
              <text x="0" y={y + BAR_HEIGHT} className="chart-label">
                {stage.label}
              </text>
              <rect
                x={LABEL_WIDTH}
                y={y + 3}
                width={trackWidth}
                height={BAR_HEIGHT}
                rx="4"
                className="chart-track"
              />
              {stage.count > 0 && (
                <rect
                  x={LABEL_WIDTH}
                  y={y + 3}
                  width={barWidth}
                  height={BAR_HEIGHT}
                  rx="4"
                  fill={`var(--chart-ramp-${index + 1})`}
                />
              )}
              {/* Direct-labelled, so the value never depends on hover -- and
                  in ink, not the mark's colour. */}
              <text x={WIDTH} y={y + BAR_HEIGHT} className="chart-value" textAnchor="end">
                {stage.count}
              </text>
            </g>
          )
        })}
      </svg>
    </figure>
  )
}
