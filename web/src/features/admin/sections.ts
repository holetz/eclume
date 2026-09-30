import { useEffect } from 'react'

// Seções do painel, na ordem da barra lateral "Plataforma". Os caminhos são relativos a /admin.
interface AdminSection {
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

/** Põe o título da aba do painel: "<título> — Admin eclume". */
export function useAdminTitle(title: string): void {
  useEffect(() => {
    document.title = `${title} — Admin eclume`
  }, [title])
}
