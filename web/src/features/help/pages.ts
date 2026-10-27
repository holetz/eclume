// Help page keys: each screen declares its own with `useHelpTopic`, and each article's `paginas`
// header says on which screens it appears in the drawer ("Nesta página"). `biblioteca`, `gravacao`
// and `busca` belong to the screens of holetz/eclume#37.
export const HELP_PAGES = {
  biblioteca: 'Biblioteca',
  gravacao: 'Gravação',
  busca: 'Busca',
  agente: 'Agente',
  pessoas: 'Pessoas',
  pessoa: 'Pessoa',
  colecoes: 'Coleções',
  tags: 'Tags',
  automacao: 'Processamento automático',
  campos: 'Campos personalizados',
  agendas: 'Tipos de agenda',
  mcp: 'Conexão MCP',
  tokens: 'Tokens de acesso',
  'app-desktop': 'App desktop',
  'app-movel': 'App móvel',
  conta: 'Conta',
  ambiente: 'Ambiente',
  ajuda: 'Central de ajuda',
} as const

export type HelpPageKey = keyof typeof HELP_PAGES

export function isHelpPageKey(key: string): key is HelpPageKey {
  return Object.hasOwn(HELP_PAGES, key)
}
