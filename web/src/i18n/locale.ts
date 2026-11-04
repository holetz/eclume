export const LOCALES = ['en', 'pt-BR'] as const
export type Locale = (typeof LOCALES)[number]
export const DEFAULT_LOCALE: Locale = 'en'

export type Catalog<T> = { [K in keyof T]: T[K] extends string ? string : Catalog<T[K]> }

export function normalize(tag: string | null | undefined): Locale | null {
  const language = tag?.trim().replaceAll('_', '-').split('-')[0].toLowerCase()
  if (language === 'pt') return 'pt-BR'
  if (language === 'en') return 'en'
  return null
}

export function browserLocale(
  languages: readonly string[] = typeof navigator === 'undefined'
    ? []
    : navigator.languages ?? [navigator.language],
): Locale {
  for (const language of languages) {
    const locale = normalize(language)
    if (locale) return locale
  }
  return DEFAULT_LOCALE
}
