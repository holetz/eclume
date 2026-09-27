import { Navigate, NavLink, Outlet, useLocation } from 'react-router'
import { errorMessage } from '../../api/problem'
import { PageStatus } from '../../app/RequireSession'
import styles from './Admin.module.css'
import { ADMIN_SECTIONS } from './sections'
import { ADMIN_LOGIN_PATH, useAdminLogout, useAdminMe } from './session'

/** Moldura do painel: fora da sessão do usuário, guardada pela sessão de admin (`GET /admin/me`). */
export function AdminLayout() {
  const me = useAdminMe()
  const logout = useAdminLogout()
  const location = useLocation()

  if (me.isPending) return <PageStatus>Carregando…</PageStatus>
  if (me.isError) {
    return (
      <PageStatus>
        <p>{errorMessage(me.error)}</p>
        <button type="button" className="btn" onClick={() => me.refetch()}>
          Tentar de novo
        </button>
      </PageStatus>
    )
  }
  if (!me.data) {
    const volta = encodeURIComponent(location.pathname + location.search)
    return <Navigate to={`${ADMIN_LOGIN_PATH}?volta=${volta}`} replace />
  }

  return (
    <main id="conteudo" className={`${styles.layout} ${styles.standalone}`}>
      <header className={styles.header}>
        <div className={styles.actions}>
          <h1>Administração</h1>
          <span className={styles.meta}>{me.data.email}</span>
          <button type="button" className="btn btn-sm" onClick={() => logout.mutate()} disabled={logout.isPending}>
            {logout.isPending ? 'Saindo…' : 'Sair'}
          </button>
        </div>
        <p className="muted">
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
