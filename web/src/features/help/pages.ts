// Chaves de página da ajuda: cada tela declara a sua com `useHelpTopic`, e o cabeçalho `paginas`
// de cada artigo diz em que telas ele aparece na gaveta ("Nesta página"). `biblioteca`, `gravacao`
// e `busca` são das telas de holetz/eclume#37.
export const HELP_PAGES = {
  biblioteca: 'Biblioteca',
  gravacao: 'Gravação',
  busca: 'Busca',
  perguntas: 'Perguntas',
  pessoas: 'Pessoas',
  pessoa: 'Pessoa',
  colecoes: 'Coleções',
  campos: 'Campos e regras',
  agendas: 'Tipos de agenda',
  mcp: 'Conexão MCP',
  tokens: 'Tokens de acesso',
  'app-desktop': 'App desktop',
  'app-movel': 'App móvel',
  ambiente: 'Ambiente',
  ajuda: 'Central de ajuda',
} as const

export type HelpPageKey = keyof typeof HELP_PAGES

export function isHelpPageKey(key: string): key is HelpPageKey {
  return Object.hasOwn(HELP_PAGES, key)
}
