import type { ReactNode } from 'react'

interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  /** O rótulo visível; sem ele, passe `label` para o nome acessível. */
  children?: ReactNode
  label?: string
}

/** O `.switch` do Design System: um checkbox com papel de interruptor. */
export function Switch({ checked, onChange, disabled, children, label }: SwitchProps) {
  return (
    <label className="switch">
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="track" />
      {children}
    </label>
  )
}
