import { useEffect } from 'react'

// Panel sections, in the order of the "Plataforma" sidebar. Paths are relative to /admin.
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

/** Sets the panel tab title: "<title> — Admin eclume". */
export function useAdminTitle(title: string): void {
  useEffect(() => {
    document.title = `${title} — Admin eclume`
  }, [title])
}
