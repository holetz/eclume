import { createInstance } from 'i18next'
import { initReactI18next } from 'react-i18next'
import enAccount from './en/account'
import enCommon from './en/common'
import enAuth from './en/auth'
import enConnect from './en/connect'
import enErrors from './en/errors'
import enShared from './en/shared'
import enShell from './en/shell'
import enTokens from './en/tokens'
import ptAccount from './pt-BR/account'
import ptCommon from './pt-BR/common'
import ptAuth from './pt-BR/auth'
import ptConnect from './pt-BR/connect'
import ptErrors from './pt-BR/errors'
import ptShared from './pt-BR/shared'
import ptShell from './pt-BR/shell'
import ptTokens from './pt-BR/tokens'
import { browserLocale, DEFAULT_LOCALE, LOCALES, normalize, type Locale } from './locale'

// Add later namespaces as one line each in both locale registries.
export const resources = {
  en: { common: enCommon, errors: enErrors, shell: enShell, shared: enShared, auth: enAuth, account: enAccount, connect: enConnect, tokens: enTokens },
  'pt-BR': { common: ptCommon, errors: ptErrors, shell: ptShell, shared: ptShared, auth: ptAuth, account: ptAccount, connect: ptConnect, tokens: ptTokens },
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
