import { useEffect, type ReactNode } from 'react'
import { NavLink, useLocation } from 'react-router'
import { Brand } from '../../app/Brand'
import { ShellFrame } from '../../app/ShellFrame'
import styles from './Admin.module.css'
import { ADMIN_HOME_PATH, useAdminLogout, type AdminAccount } from './adminSession'
import { ADMIN_SECTIONS, sectionTitle } from './sections'

function AdminBrand() {
  return (
    <div className={styles.brand}>
      <Brand to={ADMIN_HOME_PATH} />
      <span className="tag tag-outline">Admin</span>
    </div>
  )
}

/**
 * Moldura do painel (`templates/admin` do DS), à parte do app do usuário: marca com o selo Admin, o
 * grupo "Plataforma" e o rodapé com a conta de admin. Sem seletor de tema: vale a preferência salva.
 */
export function AdminShell({ admin, children }: { admin: AdminAccount; children: ReactNode }) {
  const logout = useAdminLogout()
  const { pathname } = useLocation()
  const section = pathname.split('/')[2] ?? ''

  // Depois do título que a página põe: o efeito do pai roda por último.
  useEffect(() => {
    document.title = sectionTitle(section)
  }, [section])

  return (
    <ShellFrame
      brand={<AdminBrand />}
      sidebar={
        <>
          <nav className="nav-group" aria-label="Plataforma">
            <span className="nav-group-title">Plataforma</span>
            {ADMIN_SECTIONS.map((item) => (
              <NavLink key={item.path} to={`/admin/${item.path}`} className="nav-link">
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="sidebar-footer">
            <div className={styles.account}>
              <strong>{admin.name}</strong>
              <span className="text-muted">{admin.email}</span>
            </div>
            <button type="button" className="btn btn-secondary" onClick={() => logout.mutate()} disabled={logout.isPending}>
              {logout.isPending ? 'Saindo…' : 'Sair'}
            </button>
          </div>
        </>
      }
    >
      {children}
    </ShellFrame>
  )
}
