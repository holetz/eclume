// The 100 languages of the Whisper tokenizer (whisper/tokenizer.py, `LANGUAGES`), by the code the
// model accepts. The names come from Intl in the active locale; the code is the fallback when Intl does
// not know it.
import { activeLocale, i18n } from '../i18n'

export const WHISPER_LANGUAGE_CODES = [
  'en', 'zh', 'de', 'es', 'ru', 'ko', 'fr', 'ja', 'pt', 'tr', 'pl', 'ca', 'nl', 'ar', 'sv', 'it', 'id', 'hi', 'fi', 'vi',
  'he', 'uk', 'el', 'ms', 'cs', 'ro', 'da', 'hu', 'ta', 'no', 'th', 'ur', 'hr', 'bg', 'lt', 'la', 'mi', 'ml', 'cy', 'sk',
  'te', 'fa', 'lv', 'bn', 'sr', 'az', 'sl', 'kn', 'et', 'mk', 'br', 'eu', 'is', 'hy', 'ne', 'mn', 'bs', 'kk', 'sq', 'sw',
  'gl', 'mr', 'pa', 'si', 'km', 'sn', 'yo', 'so', 'af', 'oc', 'ka', 'be', 'tg', 'sd', 'gu', 'am', 'yi', 'lo', 'uz', 'fo',
  'ht', 'ps', 'tk', 'nn', 'mt', 'sa', 'lb', 'my', 'bo', 'tl', 'mg', 'as', 'tt', 'haw', 'ln', 'ha', 'ba', 'jw', 'su', 'yue',
] as const

// Whisper uses `jw` for Javanese, which is `jv` in ISO.
const ISO_CODE: Record<string, string> = { jw: 'jv' }

/** The detection request: valid as the file, account and server language, never as a result. */
export const AUTO_LANGUAGE = 'auto'

interface LanguageOption {
  value: string
  label: string
}

function languageName(names: Intl.DisplayNames, code: string, locale: string): string {
  const name = names.of(ISO_CODE[code] ?? code) ?? code
  return name.charAt(0).toLocaleUpperCase(locale) + name.slice(1)
}

/** The Whisper languages named in the active locale and in its alphabetical order. */
export function whisperLanguages(): LanguageOption[] {
  const locale = activeLocale()
  const names = new Intl.DisplayNames([locale], { type: 'language', fallback: 'code' })
  return WHISPER_LANGUAGE_CODES.map((code) => ({ value: code, label: languageName(names, code, locale) })).sort(
    (a, b) => a.label.localeCompare(b.label, locale),
  )
}

/** The name of a requested or detected language: `pt-BR` → "Portuguese", `auto` → "Detect automatically". */
export function languageLabel(code: string): string {
  if (code === AUTO_LANGUAGE) return i18n.t('shared:language.auto')
  const locale = activeLocale()
  const names = new Intl.DisplayNames([locale], { type: 'language', fallback: 'code' })
  try {
    return languageName(names, code.split('-', 1)[0], locale)
  } catch {
    return code
  }
}
