// Os 100 idiomas do tokenizer do Whisper (whisper/tokenizer.py, `LANGUAGES`), pelo código que o
// modelo aceita. Os nomes saem do Intl em pt-BR; o código é a queda quando o Intl não conhece.
export const WHISPER_LANGUAGE_CODES = [
  'en', 'zh', 'de', 'es', 'ru', 'ko', 'fr', 'ja', 'pt', 'tr', 'pl', 'ca', 'nl', 'ar', 'sv', 'it', 'id', 'hi', 'fi', 'vi',
  'he', 'uk', 'el', 'ms', 'cs', 'ro', 'da', 'hu', 'ta', 'no', 'th', 'ur', 'hr', 'bg', 'lt', 'la', 'mi', 'ml', 'cy', 'sk',
  'te', 'fa', 'lv', 'bn', 'sr', 'az', 'sl', 'kn', 'et', 'mk', 'br', 'eu', 'is', 'hy', 'ne', 'mn', 'bs', 'kk', 'sq', 'sw',
  'gl', 'mr', 'pa', 'si', 'km', 'sn', 'yo', 'so', 'af', 'oc', 'ka', 'be', 'tg', 'sd', 'gu', 'am', 'yi', 'lo', 'uz', 'fo',
  'ht', 'ps', 'tk', 'nn', 'mt', 'sa', 'lb', 'my', 'bo', 'tl', 'mg', 'as', 'tt', 'haw', 'ln', 'ha', 'ba', 'jw', 'su', 'yue',
] as const

// O Whisper usa `jw` para o javanês, que no ISO é `jv`.
const ISO_CODE: Record<string, string> = { jw: 'jv' }

export interface LanguageOption {
  value: string
  label: string
}

function languageName(names: Intl.DisplayNames, code: string): string {
  const name = names.of(ISO_CODE[code] ?? code) ?? code
  return name.charAt(0).toLocaleUpperCase('pt-BR') + name.slice(1)
}

/** Os idiomas do Whisper nomeados em pt-BR e em ordem alfabética. */
export function whisperLanguages(): LanguageOption[] {
  const names = new Intl.DisplayNames(['pt-BR'], { type: 'language', fallback: 'code' })
  return WHISPER_LANGUAGE_CODES.map((code) => ({ value: code, label: languageName(names, code) })).sort((a, b) =>
    a.label.localeCompare(b.label, 'pt-BR'),
  )
}
