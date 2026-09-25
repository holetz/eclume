// Seções da área Administração, na ordem da subnavegação. Os caminhos são relativos a /admin.
export interface AdminSection {
  path: string
  label: string
}

export const ADMIN_SECTIONS: readonly AdminSection[] = [
  { path: 'transcricao', label: 'Transcrição' },
  { path: 'voz', label: 'Identificação por voz' },
  { path: 'agentes', label: 'Agentes' },
  { path: 'templates', label: 'Templates padrão' },
  { path: 'usuarios', label: 'Usuários e convites' },
  { path: 'segredos', label: 'Segredos' },
  { path: 'saude', label: 'Saúde' },
]

export function sectionTitle(path: string): string {
  const label = ADMIN_SECTIONS.find((section) => section.path === path)?.label ?? 'Administração'
  return `${label} — Administração`
}
