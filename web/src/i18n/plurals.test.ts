import { describe, expect, it } from 'vitest'
import { i18n, loadLocale } from '.'
import { LOCALES } from './locale'
import { completePlurals, pluralCategories } from './plurals'

type Tree = { [key: string]: string | Tree }

/** Every plural set (`<path>` with an `_other`) and the categories it answers for. */
function pluralSets(node: Tree, path = ''): Map<string, Set<string>> {
  const sets = new Map<string, Set<string>>()
  for (const [key, value] of Object.entries(node)) {
    if (typeof value !== 'string') {
      for (const [set, categories] of pluralSets(value, `${path}${key}.`)) sets.set(set, categories)
      continue
    }
    const match = /^(.+)_(zero|one|two|few|many|other)$/.exec(key)
    if (!match) continue
    const set = `${path}${match[1]}`
    sets.set(set, (sets.get(set) ?? new Set()).add(match[2]))
  }
  return sets
}

describe('plural categories', () => {
  it('completes every missing category of the locale from the _other text, keeping what the catalog says', () => {
    const catalog = { a: { items_one: '1 item', items_other: '{{count}} itens' }, plain: 'x' }
    expect(completePlurals(catalog, 'pt-BR')).toEqual({
      a: { items_one: '1 item', items_other: '{{count}} itens', items_many: '{{count}} itens' },
      plain: 'x',
    })
    expect(completePlurals(catalog, 'en')).toEqual(catalog)
  })

  it.each(LOCALES)('every plural set of the %s catalogs answers for every category of the locale', async (locale) => {
    await loadLocale(locale)
    const categories = pluralCategories(locale)
    const missing: string[] = []
    for (const namespace of Object.keys(i18n.store.data[locale] ?? {})) {
      const bundle = i18n.getResourceBundle(locale, namespace) as Tree
      for (const [set, found] of pluralSets(bundle)) {
        if (!found.has('other')) continue
        for (const category of categories) if (!found.has(category)) missing.push(`${namespace}:${set}_${category}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('an exact million in pt-BR reads as text, not as the bare key', async () => {
    await loadLocale('pt-BR')
    const t = i18n.getFixedT('pt-BR')
    expect(t('library:list.items', { count: 1_000_000 })).toBe('1000000 itens')
    expect(t('search:total.passages', { count: 2_000_000 })).toBe('2000000 trechos')
  })
})
