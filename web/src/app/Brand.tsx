import { Link } from 'react-router'

/** The Design System mark: five bars (speech as a waveform) and `eclume` in Archivo 800. */
function Mark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="0.5" y="8" width="3" height="8" />
      <rect x="5.5" y="3" width="3" height="18" />
      <rect x="10.5" y="0" width="3" height="24" />
      <rect x="15.5" y="5.5" width="3" height="13" />
      <rect x="20.5" y="9" width="3" height="6" />
    </svg>
  )
}

/** The `.brand` lockup; with `to`, it is the link to that route. */
export function Brand({ to, className }: { to?: string; className?: string }) {
  const classes = className ? `brand ${className}` : 'brand'
  if (to === undefined) {
    return (
      <span className={classes}>
        <Mark />
        {/* i18n-ignore: the brand name */}
        eclume
      </span>
    )
  }
  return (
    <Link className={classes} to={to}>
      <Mark />
      {/* i18n-ignore: the brand name */}
      eclume
    </Link>
  )
}
