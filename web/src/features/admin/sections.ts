// Seções do painel, na ordem da barra lateral "Plataforma". Os caminhos são relativos a /admin.
export interface AdminSection {
  path: string
  label: string
}

export const ADMIN_SECTIONS: readonly AdminSection[] = [
  { path: 'usuarios', label: 'Usuários' },
  { path: 'audio', label: 'Pré-processamento de áudio' },
  { path: 'transcricao', label: 'Transcrição' },
  { path: 'locutores', label: 'Locutores' },
  { path: 'agentes', label: 'Agentes' },
  { path: 'tipos-de-agenda', label: 'Tipos de agenda padrão' },
  { path: 'saude', label: 'Saúde' },
]

export const ADMIN_KICKER = 'Painel de administração'

/** Título da aba: "<seção> — Admin eclume"; fora das seções, a página não encontrada. */
export function sectionTitle(path: string): string {
  const label = ADMIN_SECTIONS.find((section) => section.path === path)?.label ?? 'Página não encontrada'
  return `${label} — Admin eclume`
}
