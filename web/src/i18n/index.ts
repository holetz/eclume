import { createInstance } from 'i18next'
import { initReactI18next } from 'react-i18next'
import enAccount from './en/account'
import enCommon from './en/common'
import enErrors from './en/errors'
import enShell from './en/shell'
import ptAccount from './pt-BR/account'
import ptCommon from './pt-BR/common'
import ptErrors from './pt-BR/errors'
import ptShell from './pt-BR/shell'
import { browserLocale, DEFAULT_LOCALE, LOCALES, normalize, type Locale } from './locale'

// Add later namespaces as one line each in both locale registries.
export const resources = {
  en: { common: enCommon, errors: enErrors, shell: enShell, account: enAccount },
  'pt-BR': { common: ptCommon, errors: ptErrors, shell: ptShell, account: ptAccount },
} as const
export const defaultNS = 'common'

export const i18n = createInstance()
void i18n.use(initReactI18next).init({
  resources,
  lng: browserLocale(),
  fallbackLng: 'en',
  supportedLngs: LOCALES,
  defaultNS,
  ns: Object.keys(resources.en),
  interpolation: { escapeValue: false },
  returnNull: false,
  initAsync: false,
})

export function activeLocale(): Locale {
  return normalize(i18n.language) ?? DEFAULT_LOCALE
}

if (typeof document !== 'undefined') document.documentElement.lang = activeLocale()

export async function setLocale(locale: Locale): Promise<void> {
  await i18n.changeLanguage(locale)
  if (typeof document !== 'undefined') document.documentElement.lang = locale
}
