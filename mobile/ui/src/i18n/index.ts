import { useSyncExternalStore } from 'react'
import en from './en'
import ptBR from './pt-BR'

export type Locale = 'en' | 'pt-BR'
export const LOCALES: readonly Locale[] = ['en', 'pt-BR']

export function normalize(tag: string | null | undefined): Locale | null {
  const base = tag?.trim().replaceAll('_', '-').split('-')[0].toLowerCase()
  return base === 'en' ? 'en' : base === 'pt' ? 'pt-BR' : null
}

export function deviceLocale(languages: readonly string[] = navigator.languages): Locale {
  for (const tag of languages) {
    const locale = normalize(tag)
    if (locale) return locale
  }
  return 'en'
}

export function deviceTag(languages: readonly string[] = navigator.languages): string | null {
  return languages.find((tag) => normalize(tag) !== null) ?? languages[0] ?? null
}

let current: Locale = 'en'
const listeners = new Set<() => void>()

export function activeLocale(): Locale {
  return current
}

export function setLocale(locale: Locale): void {
  if (typeof document !== 'undefined') document.documentElement.lang = locale
  if (current === locale) return
  current = locale
  listeners.forEach((listener) => listener())
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

type Leaves<T> = {
  [K in keyof T & string]: T[K] extends string ? K : `${K}.${Leaves<T[K]>}`
}[keyof T & string]
type PluralBase<K> = K extends `${infer Base}_${'one' | 'other' | 'zero'}` ? Base : never
export type TranslationKey = Leaves<typeof en> | PluralBase<Leaves<typeof en>>
type Variables = Record<string, string | number>

function lookup(key: string): string | undefined {
  let value: unknown = current === 'en' ? en : ptBR
  for (const part of key.split('.')) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) return undefined
    value = (value as Record<string, unknown>)[part]
  }
  return typeof value === 'string' ? value : undefined
}

export function t(key: TranslationKey, vars: Variables = {}): string {
  let text = lookup(key)
  if (typeof vars.count === 'number' && lookup(`${key}_one`) !== undefined && lookup(`${key}_other`) !== undefined) {
    const suffix = vars.count === 0 && lookup(`${key}_zero`) !== undefined
      ? 'zero'
      : new Intl.PluralRules(current).select(vars.count) === 'one' ? 'one' : 'other'
    text = lookup(`${key}_${suffix}`)
  }
  return text?.replace(/\{([^{}]+)\}/g, (placeholder, name: string) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : placeholder) ?? key
}

export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, activeLocale)
}

export function useT(): typeof t {
  useLocale()
  return t
}

export function formatLocale(): string {
  return activeLocale()
}
