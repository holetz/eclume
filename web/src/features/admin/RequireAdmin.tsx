import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router'
import { onAdminUnauthorized } from '../../api/client'
import { errorMessage } from '../../api/problem'
import { PageStatus } from '../../app/RequireSession'
import { AdminShell } from './AdminShell'
import { ADMIN_LOGIN_PATH, ADMIN_ME_KEY, useAdminMe } from './adminSession'

/**
 * Guarda do painel pela sessão de admin (`GET /admin/me`): sem ela, leva ao login do admin com a
 * rota de volta. Esconder link não é controle de acesso: a fronteira é o cookie de admin no server.
 */
export function RequireAdmin() {
  const me = useAdminMe()
  const location = useLocation()
  const queryClient = useQueryClient()

  // Um 401 durante o uso (sessão expirada) zera a sessão local, e a guarda leva ao login.
  useEffect(() => onAdminUnauthorized(() => queryClient.setQueryData(ADMIN_ME_KEY, null)), [queryClient])

  if (me.isPending) return <PageStatus>Carregando…</PageStatus>
  // Um refetch que falha com a sessão já carregada não derruba o shell: o React Query mantém o
  // dado, e a falha vira a faixa de conexão. A tela de erro só aparece sem sessão nenhuma em cache.
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
    return <Navigate to={`${ADMIN_LOGIN_PATH}?volta=${volta}`} replace />
  }
  return (
    <AdminShell admin={me.data}>
      <Outlet />
    </AdminShell>
  )
}
