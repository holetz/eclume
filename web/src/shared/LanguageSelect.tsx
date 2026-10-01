import { useMemo } from 'react'
import { AUTO_LANGUAGE, languageLabel, whisperLanguages } from '../lib/languages'

interface Props {
  id?: string
  /** Rótulo acessível, quando não há `<label>` (a linha de uma tabela). */
  label?: string
  className?: string
  /** O idioma escolhido; `''` é o padrão, nomeado por `defaultLabel`. */
  value: string
  onChange: (value: string) => void
  /** O rótulo do padrão ("Padrão da conta: Português"); sem ele, não há a opção do padrão. */
  defaultLabel?: string
  disabled?: boolean
}

/** O seletor de idioma da transcrição: o padrão nomeado, Detectar automaticamente e os idiomas do Whisper. */
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
