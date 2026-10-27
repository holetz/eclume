import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router'
import { onAdminUnauthorized } from '../../api/client'
import { errorMessage } from '../../api/problem'
import { PageStatus } from '../../app/RequireSession'
import { AdminShell } from './AdminShell'
import { ADMIN_LOGIN_PATH, ADMIN_ME_KEY, useAdminMe } from './adminSession'

/**
 * Guards the panel by the admin session (`GET /admin/me`): without it, goes to the admin sign-in
 * with the return route. Hiding a link is not access control: the admin cookie on the server is.
 */
export function RequireAdmin() {
  const me = useAdminMe()
  const location = useLocation()
  const queryClient = useQueryClient()

  // A 401 while in use (expired session) clears the local session, and the guard sends to sign-in.
  useEffect(() => onAdminUnauthorized(() => queryClient.setQueryData(ADMIN_ME_KEY, null)), [queryClient])

  if (me.isPending) return <PageStatus>Carregando…</PageStatus>
  // A refetch failing with the session already loaded keeps the shell up: React Query keeps the
  // data, and the failure becomes the connection banner. The error screen needs no cached session.
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
    const returnPath = encodeURIComponent(location.pathname + location.search)
    return <Navigate to={`${ADMIN_LOGIN_PATH}?volta=${returnPath}`} replace />
  }
  return (
    <AdminShell admin={me.data}>
      <Outlet />
    </AdminShell>
  )
}
