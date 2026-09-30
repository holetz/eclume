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

// Engrenagem, como o `Settings` do lucide na web: o círculo com raios do DS lia como tema.
export function IconeAjustes() {
  return (
    <svg {...traco}>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
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
