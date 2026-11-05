// Help page keys: each screen declares its own with `useHelpTopic`, and each article's `paginas`
// header says on which screens it appears in the drawer ("Nesta página"). `biblioteca`, `gravacao`
// and `busca` belong to the screens of holetz/eclume#37. The names live in the `help` catalog
// (`help:page.<key>`), read when used, so they follow the locale.
import { i18n } from '../../i18n'

const KEYS = [
  'biblioteca',
  'gravacao',
  'busca',
  'agente',
  'pessoas',
  'pessoa',
  'colecoes',
  'tags',
  'automacao',
  'campos',
  'agendas',
  'mcp',
  'tokens',
  'app-desktop',
  'app-movel',
  'conta',
  'ambiente',
  'ajuda',
] as const

export type HelpPageKey = (typeof KEYS)[number]

/** Each help page's name, in the active locale. */
export const HELP_PAGES = Object.defineProperties(
  {},
  Object.fromEntries(KEYS.map((key) => [key, { enumerable: true, get: () => i18n.t(`help:page.${key}`) }])),
) as Readonly<Record<HelpPageKey, string>>

export function isHelpPageKey(key: string): key is HelpPageKey {
  return Object.hasOwn(HELP_PAGES, key)
}
