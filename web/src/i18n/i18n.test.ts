import { describe, expect, it } from 'vitest'
import en from './en'
import { activeLocale, i18n, setLocale } from './index'
import { browserLocale, normalize, startLocale } from './locale'
import ptBR from './pt-BR'

const resources = { en, 'pt-BR': ptBR }

describe('normalize', () => {
  it.each([
    ['pt', 'pt-BR'],
    ['pt-br', 'pt-BR'],
    ['pt_BR', 'pt-BR'],
    ['PT-pt', 'pt-BR'],
    [' pt-PT ', 'pt-BR'],
    ['en-US', 'en'],
    ['EN', 'en'],
    ['fr', null],
    ['', null],
    [null, null],
    [undefined, null],
  ])('normalizes %s to %s', (tag, locale) => {
    expect(normalize(tag)).toBe(locale)
  })
})

describe('browserLocale', () => {
  it.each([
    { languages: ['fr-FR', 'pt-BR'], locale: 'pt-BR' },
    { languages: [], locale: 'en' },
    { languages: ['de'], locale: 'en' },
    { languages: ['en-US', 'pt-BR'], locale: 'en' },
  ])('selects $locale for $languages', ({ languages, locale }) => {
    expect(browserLocale(languages)).toBe(locale)
  })
})

function keyPaths(value: unknown, prefix = ''): string[] {
  if (typeof value === 'string') {
    expect(value.trim(), prefix).not.toBe('')
    return [prefix]
  }
  expect(value, prefix).toBeTypeOf('object')
  expect(value, prefix).not.toBeNull()
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    keyPaths(child, prefix ? `${prefix}.${key}` : key),
  )
}

describe('catalogs', () => {
  it('has matching key paths and non-empty strings across every namespace', () => {
    const englishPaths = keyPaths(resources.en).sort()
    expect(englishPaths.length).toBeGreaterThan(0)
    for (const catalog of Object.values(resources)) {
      expect(keyPaths(catalog).sort()).toEqual(englishPaths)
    }
  })
})

describe('setLocale', () => {
  it('changes translations and the document language', async () => {
    try {
      await setLocale('en')
      expect(activeLocale()).toBe('en')
      expect(i18n.t('common:save')).toBe('Save')
      expect(document.documentElement.lang).toBe('en')
    } finally {
      await setLocale('pt-BR')
    }
    expect(i18n.t('common:save')).toBe('Salvar')
    expect(document.documentElement.lang).toBe('pt-BR')
  })
})

describe('startLocale', () => {
  it('prefers the locale this browser last showed, then the browser language', async () => {
    expect(startLocale()).toBe('pt-BR')
    await setLocale('en')
    expect(localStorage.getItem('eclume-locale')).toBe('en')
    expect(startLocale()).toBe('en')
    await setLocale('pt-BR')
    localStorage.clear()
    expect(startLocale()).toBe('pt-BR')
  })
})
