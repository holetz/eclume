// Os ícones do DS (examples/mobile.html): traço de 2 px, pontas quadradas.

const traco = {
  width: 22,
  height: 22,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'square' as const,
  'aria-hidden': true,
}

const cheio = { ...traco, fill: 'currentColor', stroke: 'none' }

export function IconeVoltar() {
  return (
    <svg {...traco}>
      <path d="M15 5l-7 7 7 7" />
    </svg>
  )
}

export function IconeAjustes() {
  return (
    <svg {...traco}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" />
    </svg>
  )
}

export function IconePausar() {
  return (
    <svg {...traco}>
      <path d="M8 5v14M16 5v14" />
    </svg>
  )
}

export function IconeMarcador() {
  return (
    <svg {...traco}>
      <path d="M5 21V4h12l-2.5 4L17 12H5" />
    </svg>
  )
}

export function IconeParar() {
  return (
    <svg {...cheio}>
      <rect x="6" y="6" width="12" height="12" />
    </svg>
  )
}

export function IconeTocar() {
  return (
    <svg {...cheio}>
      <path d="M7 5v14l11-7z" />
    </svg>
  )
}
