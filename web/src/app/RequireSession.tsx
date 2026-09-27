import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router'
import { errorMessage } from '../api/problem'
import { AppShell } from './AppShell'
import styles from './RequireSession.module.css'
import { useLogout, useMe } from './session'

export function PageStatus({ children }: { children: ReactNode }) {
  return (
    <div className={styles.status} role="status">
      {children}
    </div>
  )
}

/** Guarda das rotas autenticadas: sem sessão, leva ao login com a rota de volta. */
export function RequireSession() {
  const me = useMe()
  const location = useLocation()
  const logout = useLogout()

  if (me.isPending) return <PageStatus>Carregando…</PageStatus>
  if (me.isError) {
    return (
      <PageStatus>
        <p>{errorMessage(me.error)}</p>
        <button type="button" className="btn btn-secondary" onClick={() => me.refetch()}>
          Tentar de novo
        </button>
      </PageStatus>
    )
  }
  if (!me.data) {
    const volta = encodeURIComponent(location.pathname + location.search)
    return <Navigate to={`/entrar?volta=${volta}`} replace />
  }
  const { user } = me.data
  return (
    <AppShell
      user={{ name: user.name, email: user.email, role: user.role }}
      onLogout={() => logout.mutate()}
      loggingOut={logout.isPending}
    />
  )
}
