import { useMemo } from 'react'
import { AUTO_LANGUAGE, languageLabel, whisperLanguages } from '../lib/languages'

interface Props {
  id?: string
  /** Accessible label, when there is no `<label>` (a table row). */
  label?: string
  className?: string
  /** The chosen language; `''` is the default, named by `defaultLabel`. */
  value: string
  onChange: (value: string) => void
  /** The default's label ("Padrão da conta: Português"); without it, there is no default option. */
  defaultLabel?: string
  disabled?: boolean
}

/** The transcription language picker: the named default, Detectar automaticamente and the Whisper languages. */
export function LanguageSelect({ id, label, className, value, onChange, defaultLabel, disabled }: Props) {
  const languages = useMemo(() => whisperLanguages(), [])
  const unknown = value !== '' && value !== AUTO_LANGUAGE && !languages.some((option) => option.value === value)
  return (
    <select
      id={id}
      aria-label={label}
      className={className ?? 'input'}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      {defaultLabel !== undefined && <option value="">{defaultLabel}</option>}
      {unknown && <option value={value}>{languageLabel(value)}</option>}
      <option value={AUTO_LANGUAGE}>Detectar automaticamente</option>
      <optgroup label={`Idiomas (${languages.length})`}>
        {languages.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </optgroup>
    </select>
  )
}
