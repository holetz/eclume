import type { ReactNode } from 'react'

interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  /** The visible label; without it, pass `label` for the accessible name. */
  children?: ReactNode
  label?: string
}

/** The Design System `.switch`: a checkbox with the switch role. */
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
