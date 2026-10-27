import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useId, useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { api } from '../../api/client'
import { ApiError, errorMessage, unwrap } from '../../api/problem'
import { refreshSession } from '../../app/session'
import { usePageTitle } from '../../app/usePageTitle'
import { AuthLayout } from './AuthLayout'
import { MIN_PASSWORD } from './signup'

const INVALID = 'Este link venceu ou já foi usado. Peça outro a quem administra o servidor.'
export const RESET_DONE = 'Senha redefinida. Entre com a nova.'

/**
 * Reset the password (`/redefinir-senha#<secret>`), through the link the admin generated. The secret comes in the
 * fragment, which reaches neither the server nor the logs: the page reads it on mount, outside the session.
 */
export function ResetPasswordPage() {
  usePageTitle('Redefinir a senha')
  const location = useLocation()
  const [token] = useState(() => location.hash.slice(1))
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const check = useQuery({
    queryKey: ['password-reset', token],
    queryFn: () => unwrap(api.POST('/api/v1/auth/password-reset/check', { body: { token } })),
    enabled: token !== '',
    retry: false,
    staleTime: Infinity,
  })
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const ids = { password: useId(), confirm: useId(), hint: useId(), error: useId() }

  const mismatch = confirm !== '' && confirm !== password
  const ready = password.length >= MIN_PASSWORD && confirm === password

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ready) return
    setError(null)
    setSubmitting(true)
    try {
      await unwrap(api.POST('/api/v1/auth/password-reset', { body: { token, new_password: password } }))
      // The account's sessions ended, including one open in this browser.
      await refreshSession(queryClient)
      navigate('/entrar', { replace: true, state: { notice: RESET_DONE } })
    } catch (caught) {
      setError(caught instanceof ApiError && caught.code === 'invalid_reset_link' ? INVALID : errorMessage(caught))
      setSubmitting(false)
    }
  }

  const back = (
    <p className="text-muted auth-note">
      <Link to="/entrar">Voltar para a entrada</Link>
    </p>
  )

  if (token !== '' && check.isPending) {
    return (
      <AuthLayout>
        <p role="status">Carregando…</p>
      </AuthLayout>
    )
  }
  if (token === '' || check.isError) {
    const invalid = token === '' || (check.error instanceof ApiError && check.error.code === 'invalid_reset_link')
    return (
      <AuthLayout>
        <div>
          <h2>Redefinir a senha</h2>
          <p className="alert alert-error" role="alert">
            {invalid ? INVALID : errorMessage(check.error)}
          </p>
          {back}
        </div>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout>
      <form onSubmit={submit} noValidate>
        <div>
          <h2>Redefinir a senha</h2>
          <p className="text-muted">
            Conta <strong>{check.data?.email}</strong>. Ao redefinir, as sessões abertas desta conta são encerradas.
          </p>
        </div>
        <div className="field">
          <label htmlFor={ids.password}>Nova senha</label>
          <input
            id={ids.password}
            className="input"
            type="password"
            autoComplete="new-password"
            required
            minLength={MIN_PASSWORD}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-describedby={ids.hint}
          />
          <span id={ids.hint} className="field-hint">
            Pelo menos {MIN_PASSWORD} caracteres.
          </span>
        </div>
        <div className="field">
          <label htmlFor={ids.confirm}>Repita a nova senha</label>
          <input
            id={ids.confirm}
            className="input"
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            aria-invalid={mismatch || undefined}
          />
          {mismatch && <span className="field-hint">As senhas não conferem.</span>}
        </div>
        {error && (
          <p id={ids.error} className="alert alert-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn btn-primary btn-block" disabled={submitting || !ready}>
          {submitting ? 'Redefinindo…' : 'Redefinir a senha'}
        </button>
        {back}
      </form>
    </AuthLayout>
  )
}
