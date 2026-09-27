import { useId, useState, type FormEvent } from 'react'
import { Navigate, useNavigate, useSearchParams } from 'react-router'
import { ApiError, errorMessage } from '../../api/problem'
import { AuthLayout } from '../auth/AuthLayout'
import { adminReturnPath, useAdminLogin, useAdminMe } from './adminSession'
import { useAdminTitle } from './sections'

/** Login da conta de admin, na variante `.auth-admin`: sem cadastro nem "esqueci a senha" (é pelo CLI). */
export function AdminSignInPage() {
  useAdminTitle('Entrar')
  const [params] = useSearchParams()
  const volta = adminReturnPath(params.get('volta'))
  const me = useAdminMe()
  const login = useAdminLogin()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const errorId = useId()

  if (me.data) return <Navigate to={volta} replace />

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    login.mutate({ email: email.trim(), password }, { onSuccess: () => navigate(volta, { replace: true }) })
  }

  const error = login.error
    ? login.error instanceof ApiError && login.error.status === 401
      ? 'E-mail ou senha incorretos.'
      : errorMessage(login.error)
    : null

  return (
    <AuthLayout variant="admin">
      <form onSubmit={submit} noValidate>
        <h2>Entrar como admin</h2>
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
        <button type="submit" className="btn btn-primary btn-block" disabled={login.isPending || !email || !password}>
          {login.isPending ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
    </AuthLayout>
  )
}
