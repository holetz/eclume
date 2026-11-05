// Help page keys: each screen declares its own with `useHelpTopic`, and each article's `pages`
// header says on which screens it appears in the drawer ("On this page"). The label of each key is
// `shell:helpCenter.pages.<key>`. `biblioteca`, `gravacao` and `busca` belong to the screens of
// holetz/eclume#37. The keys are wire names (route and header vocabulary), not display text.
export const HELP_PAGES = [
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

export type HelpPageKey = (typeof HELP_PAGES)[number]

export function isHelpPageKey(key: string): key is HelpPageKey {
  return (HELP_PAGES as readonly string[]).includes(key)
}
