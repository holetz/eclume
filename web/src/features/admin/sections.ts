import { useEffect } from 'react'
import { i18n } from '../../i18n'

// Panel sections, in the order of the "Plataforma" sidebar. Paths are relative to /admin.
type AdminPath = 'usuarios' | 'audio' | 'transcricao' | 'locutores' | 'agentes' | 'tipos-de-agenda' | 'saude'

interface AdminSection {
  readonly path: AdminPath
  readonly label: string
}

const section = (path: AdminPath): AdminSection => ({
  path,
  get label() {
    return i18n.t(`admin:section.${path}`)
  },
})

export const ADMIN_SECTIONS: readonly AdminSection[] = [
  section('usuarios'),
  section('audio'),
  section('transcricao'),
  section('locutores'),
  section('agentes'),
  section('tipos-de-agenda'),
  section('saude'),
]

/** Sets the panel tab title: "<title> — Admin eclume". */
export function useAdminTitle(title: string): void {
  const tabTitle = i18n.t('admin:tabTitle', { title })
  useEffect(() => {
    document.title = tabTitle
  }, [tabTitle])
}
