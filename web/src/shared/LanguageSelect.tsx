import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { AUTO_LANGUAGE, languageLabel, whisperLanguages } from '../lib/languages'

interface Props {
  id?: string
  /** Accessible label, when there is no `<label>` (a table row). */
  label?: string
  className?: string
  /** The chosen language; `''` is the default, named by `defaultLabel`. */
  value: string
  onChange: (value: string) => void
  /** The default's label ("Account default: Portuguese"); without it, there is no default option. */
  defaultLabel?: string
  disabled?: boolean
}

/** The transcription language picker: the named default, automatic detection and the Whisper languages. */
export function LanguageSelect({ id, label, className, value, onChange, defaultLabel, disabled }: Props) {
  const { t, i18n } = useTranslation('shared')
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the names follow the active language
  const languages = useMemo(() => whisperLanguages(), [i18n.language])
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
      <option value={AUTO_LANGUAGE}>{t('language.auto')}</option>
      <optgroup label={t('language.list', { count: languages.length })}>
        {languages.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </optgroup>
    </select>
  )
}
