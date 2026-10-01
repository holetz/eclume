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
 * Guarda das rotas autenticadas: sem sessão, leva ao login com a rota de volta; com o aviso em
 * vigor ainda não aceito, pede o aceite antes do shell.
 */
export function RequireSession() {
  const me = useMe()
  const location = useLocation()
  const logout = useLogout()
  const queryClient = useQueryClient()
  const userId = me.data?.user.id

  // A sessão que já vinha do cookie (sem passar pelo login) também marca a conta da aba.
  useEffect(() => {
    if (userId) enterAccount(queryClient, userId, ME_KEY)
  }, [queryClient, userId])

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
