// Amber accent mark: a hexagon with a white chevron, kept fixed-contrast
// (white on amber) regardless of light/dark theme, the same way .btn-accent
// forces ink text on amber -- a logo's internal contrast isn't page theming.
export default function BrandMark({ className = '', size = 24, ...props }) {
  return (
    <svg
      viewBox="0 0 28 28"
      width={size}
      height={size}
      aria-hidden="true"
      className={`text-warning flex-shrink-0 ${className}`}
      {...props}
    >
      <path d="M14 1 26 7.5v13L14 27 2 20.5v-13Z" fill="currentColor" />
      <path
        d="M10 8 18 14l-8 6"
        fill="none"
        stroke="#fff"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
