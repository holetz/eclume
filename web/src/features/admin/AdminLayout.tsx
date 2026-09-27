import { NavLink, Outlet } from 'react-router'
import styles from './Admin.module.css'
import { useAdminLogout, type AdminAccount } from './adminSession'
import { ADMIN_SECTIONS } from './sections'

/** Moldura do painel, já dentro da guarda da sessão de admin (`RequireAdmin`). */
export function AdminLayout({ admin }: { admin: AdminAccount }) {
  const logout = useAdminLogout()

  return (
    <main id="conteudo" className={`${styles.layout} ${styles.standalone}`}>
      <header className={styles.header}>
        <div className={styles.actions}>
          <h1>Administração</h1>
          <span className={styles.meta}>{admin.email}</span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => logout.mutate()} disabled={logout.isPending}>
            {logout.isPending ? 'Saindo…' : 'Sair'}
          </button>
        </div>
        <p className="text-muted">
          Configuração da plataforma, contas e saúde do serviço. Mudanças valem para os próximos jobs.
        </p>
      </header>
      <nav aria-label="Seções da administração" className={styles.tabs}>
        <ul>
          {ADMIN_SECTIONS.map((section) => (
            <li key={section.path}>
              <NavLink to={`/admin/${section.path}`} className={styles.tab}>
                {section.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <Outlet />
    </main>
  )
}
