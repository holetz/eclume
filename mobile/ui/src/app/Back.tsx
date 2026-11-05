import { BackIcon } from './Icons'

/** The top bar with the DS's back button (`.m-back`). */
export function Back({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <div className="m-top m-top-back">
      <button type="button" className="m-back" onClick={onBack}>
        <BackIcon />
        {label}
      </button>
    </div>
  )
}
