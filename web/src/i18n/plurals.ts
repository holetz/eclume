// The plural forms a catalog must answer for. i18next picks `<key>_<category>` from `Intl.PluralRules`, and
// pt-BR has a `many` category (exact millions: 1.000.000 gravações) that the catalogs do not spell out. A missing
// category does not fall back to `_other`: the screen shows the bare key. Every set is completed here, from its
// `_other` text, before the catalog reaches i18next.

type Tree = { [key: string]: string | Tree }

const SUFFIX = '_other'

/** The plural categories of the locale, as `Intl.PluralRules` names them. */
export function pluralCategories(locale: string): readonly Intl.LDMLPluralRule[] {
  return new Intl.PluralRules(locale).resolvedOptions().pluralCategories
}

/** A copy of the catalog where every `<key>_other` has a `<key>_<category>` for each category of the locale. */
export function completePlurals<T extends object>(catalog: T, locale: string): T {
  const categories = pluralCategories(locale)
  const walk = (node: Tree): Tree => {
    const out: Tree = {}
    for (const [key, value] of Object.entries(node)) out[key] = typeof value === 'string' ? value : walk(value)
    for (const [key, value] of Object.entries(node)) {
      if (typeof value !== 'string' || !key.endsWith(SUFFIX)) continue
      const base = key.slice(0, -SUFFIX.length)
      for (const category of categories) out[`${base}_${category}`] ??= value
    }
    return out
  }
  return walk(catalog as Tree) as T
}
