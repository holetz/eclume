import { useQueryClient } from '@tanstack/react-query'
import { useEffect, type ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router'
import { errorMessage } from '../api/problem'
import { NoticePage } from '../features/auth/NoticePage'
import { enterAccount } from './accountScope'
import { AppShell } from './AppShell'
import styles from './RequireSession.module.css'
import { ME_KEY, useLogout, useMe } from './session'

export function PageStatus({ children }: { children: ReactNode }) {
  return (
    <div className={styles.status} role="status">
      {children}
    </div>
  )
}

/**
 * Guard of the authenticated routes: without a session, leads to the login with the return route; with the notice in
 * force not yet accepted, asks for acceptance before the shell.
 */
export function RequireSession() {
  const me = useMe()
  const location = useLocation()
  const logout = useLogout()
  const queryClient = useQueryClient()
  const userId = me.data?.user.id

  // The session that already came from the cookie (without going through login) also marks the tab's account.
  useEffect(() => {
    if (userId) enterAccount(queryClient, userId, ME_KEY)
  }, [queryClient, userId])

  if (me.isPending) return <PageStatus>Carregando…</PageStatus>
  // A refetch that fails with the session already loaded does not bring the shell down: React Query keeps the
  // data, and the failure becomes the connection banner. The error screen only shows with no session at all in cache.
  if (me.isError && !me.data) {
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
  if (me.data.notice_required) {
    return <NoticePage onLogout={() => logout.mutate()} loggingOut={logout.isPending} />
  }
  const { user } = me.data
  return (
    <AppShell
      user={{ name: user.name, email: user.email }}
      onLogout={() => logout.mutate()}
      loggingOut={logout.isPending}
    />
  )
}
