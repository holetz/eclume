import { Link } from 'react-router'

/** A marca do Design System: cinco barras (uma fala como forma de onda) e `eclume` em Archivo 800. */
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

/** A lockup `.brand`; com `to`, é o link para essa rota. */
export function Brand({ to, className }: { to?: string; className?: string }) {
  const classes = className ? `brand ${className}` : 'brand'
  if (to === undefined) {
    return (
      <span className={classes}>
        <Mark />
        eclume
      </span>
    )
  }
  return (
    <Link className={classes} to={to}>
      <Mark />
      eclume
    </Link>
  )
}
