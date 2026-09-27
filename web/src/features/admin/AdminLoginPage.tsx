import { useQueryClient } from '@tanstack/react-query'
import { useId, useState, type FormEvent } from 'react'
import { Navigate, useNavigate, useSearchParams } from 'react-router'
import { api } from '../../api/client'
import { ApiError, errorMessage, unwrap } from '../../api/problem'
import { usePageTitle } from '../../app/usePageTitle'
import { AuthLayout } from '../auth/AuthLayout'
import { ADMIN_LOGIN_PATH, ADMIN_ME_KEY, useAdminMe } from './session'

/** Volta dentro do painel; qualquer outra coisa cai no início do painel. */
function adminReturnPath(value: string | null): string {
  return value && value.startsWith('/admin') && !value.startsWith(ADMIN_LOGIN_PATH) ? value : '/admin'
}

/** Login da conta de admin, na mesma `.auth` do login de usuário. */
export function AdminLoginPage() {
  usePageTitle('Entrar no painel admin')
  const [params] = useSearchParams()
  const volta = adminReturnPath(params.get('volta'))
  const me = useAdminMe()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const errorId = useId()

  if (me.data) return <Navigate to={volta} replace />

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await unwrap(api.POST('/api/v1/admin/auth/login', { body: { email: email.trim(), password } }))
      await queryClient.invalidateQueries({ queryKey: ADMIN_ME_KEY })
      navigate(volta, { replace: true })
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.status === 401 ? 'E-mail ou senha incorretos.' : errorMessage(caught),
      )
      setSubmitting(false)
    }
  }

  return (
    <AuthLayout>
      <form onSubmit={submit} noValidate>
        <h2>Painel admin</h2>
        <p className="text-muted">Entre com a conta de admin da plataforma, que é separada da conta de usuário.</p>
        <div className="field">
          <label htmlFor="admin-login-email">E-mail</label>
          <input
            id="admin-login-email"
            className="input"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-describedby={error ? errorId : undefined}
          />
        </div>
        <div className="field">
          <label htmlFor="admin-login-password">Senha</label>
          <input
            id="admin-login-password"
            className="input"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-describedby={error ? errorId : undefined}
          />
        </div>
        {error && (
          <p id={errorId} className="alert alert-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn btn-primary btn-block" disabled={submitting || !email || !password}>
          {submitting ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
    </AuthLayout>
  )
}
