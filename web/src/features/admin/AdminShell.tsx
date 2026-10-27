import type { ReactNode } from 'react'
import { NavLink } from 'react-router'
import { Brand } from '../../app/Brand'
import { ShellFrame } from '../../app/ShellFrame'
import styles from './Admin.module.css'
import { ADMIN_HOME_PATH, useAdminLogout, type AdminAccount } from './adminSession'
import { ADMIN_SECTIONS } from './sections'

function AdminBrand() {
  return (
    <div className={styles.brand}>
      <Brand to={ADMIN_HOME_PATH} />
      <span className="tag tag-outline">Admin</span>
    </div>
  )
}

/**
 * The panel frame (the DS `templates/admin`), apart from the user app: brand with the Admin badge, the
 * "Plataforma" group and the footer with the admin account. No theme selector: the saved preference holds.
 */
export function AdminShell({ admin, children }: { admin: AdminAccount; children: ReactNode }) {
  const logout = useAdminLogout()
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
