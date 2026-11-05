// The UI language. Only the active locale's catalogs are loaded: `startI18n` picks the locale before
// the first render (the locale this browser last used, else the browser language, else en) and
// loads its chunk; the other locale loads only when someone switches (`setLocale`).
import { createInstance } from 'i18next'
import { initReactI18next } from 'react-i18next'
import type en from './en'
import { DEFAULT_LOCALE, LOCALES, normalize, rememberLocale, startLocale, type Locale } from './locale'
import { completePlurals } from './plurals'

export type Resources = typeof en
export const defaultNS = 'common'

const loaders: Record<Locale, () => Promise<{ default: Record<string, unknown> }>> = {
  en: () => import('./en'),
  'pt-BR': () => import('./pt-BR'),
}

export const i18n = createInstance()
void i18n.use(initReactI18next).init({
  resources: {},
  partialBundledLanguages: true,
  lng: DEFAULT_LOCALE,
  // Every catalog has every key (`Catalog<typeof en>`): no fallback chunk to load.
  fallbackLng: false,
  supportedLngs: LOCALES,
  defaultNS,
  interpolation: { escapeValue: false },
  returnNull: false,
  initAsync: false,
})

/** Loads the locale's catalogs once; a later call is free. */
export async function loadLocale(locale: Locale): Promise<void> {
  if (i18n.hasResourceBundle(locale, defaultNS)) return
  const { default: catalogs } = await loaders[locale]()
  for (const [namespace, catalog] of Object.entries(catalogs)) {
    i18n.addResourceBundle(locale, namespace, completePlurals(catalog as object, locale), true, true)
  }
}

export function activeLocale(): Locale {
  return normalize(i18n.language) ?? DEFAULT_LOCALE
}

/** Loads the starting locale and makes it active; the app mounts after it. */
export async function startI18n(locale: Locale = startLocale()): Promise<void> {
  await loadLocale(locale)
  await i18n.changeLanguage(locale)
  if (typeof document !== 'undefined') document.documentElement.lang = locale
}

/** Switches in place, with no reload, loading the locale first when this tab has not used it yet. */
export async function setLocale(locale: Locale): Promise<void> {
  await loadLocale(locale)
  await i18n.changeLanguage(locale)
  if (typeof document !== 'undefined') document.documentElement.lang = locale
  rememberLocale(locale)
}
