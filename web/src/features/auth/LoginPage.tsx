import { useQueryClient } from '@tanstack/react-query'
import { useId, useState, type FormEvent } from 'react'
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router'
import { api } from '../../api/client'
import { ApiError, errorMessage, unwrap } from '../../api/problem'
import { refreshSession, safeReturnPath, useMe } from '../../app/session'
import { usePageTitle } from '../../app/usePageTitle'
import { AuthLayout } from './AuthLayout'

export function LoginPage() {
  usePageTitle('Entrar')
  const [params] = useSearchParams()
  // The notice for someone arriving from another screen, such as the deleted account or the reset password.
  const notice = (useLocation().state as { notice?: string } | null)?.notice
  const returnPath = safeReturnPath(params.get('volta'))
  const me = useMe()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const errorId = useId()

  if (me.data) return <Navigate to={returnPath} replace />

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await unwrap(api.POST('/api/v1/auth/login', { body: { email: email.trim(), password } }))
      await refreshSession(queryClient)
      navigate(returnPath, { replace: true })
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.status === 401
          ? 'E-mail ou senha incorretos.'
          : errorMessage(caught),
      )
      setSubmitting(false)
    }
  }

  return (
    <AuthLayout>
      <form onSubmit={submit} noValidate>
        <h2>Entrar</h2>
        {notice && (
          <p className="alert alert-success" role="status">
            {notice}
          </p>
        )}
        <div className="field">
          <label htmlFor="login-email">E-mail</label>
          <input
            id="login-email"
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
          <label htmlFor="login-password">Senha</label>
          <input
            id="login-password"
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
        <p className="text-muted auth-note">Esqueceu a senha? Peça um link a quem administra o servidor.</p>
        <p className="text-muted auth-note">
          Não tem conta? <Link to="/cadastro">Criar conta</Link>
        </p>
      </form>
    </AuthLayout>
  )
}
