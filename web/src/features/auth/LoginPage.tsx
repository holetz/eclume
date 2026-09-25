import { useQueryClient } from '@tanstack/react-query'
import { useId, useState, type FormEvent } from 'react'
import { Navigate, useNavigate, useSearchParams } from 'react-router'
import { api } from '../../api/client'
import { ApiError, errorMessage, unwrap } from '../../api/problem'
import { ME_KEY, safeReturnPath, useMe } from '../../app/session'
import { usePageTitle } from '../../app/usePageTitle'
import styles from './LoginPage.module.css'

export function LoginPage() {
  usePageTitle('Entrar')
  const [params] = useSearchParams()
  const volta = safeReturnPath(params.get('volta'))
  const me = useMe()
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
      await unwrap(api.POST('/api/v1/auth/login', { body: { email: email.trim(), password } }))
      await queryClient.invalidateQueries({ queryKey: ME_KEY })
      navigate(volta, { replace: true })
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
    <main className={styles.page}>
      <div className={`card ${styles.card}`}>
        <p className={styles.brand}>eclume</p>
        <h1>Entrar</h1>
        <p className="muted">Transcrição institucional da sua organização.</p>
        <form className={styles.form} onSubmit={submit} noValidate>
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
          <button type="submit" className="btn btn-primary" disabled={submitting || !email || !password}>
            {submitting ? 'Entrando…' : 'Entrar'}
          </button>
        </form>
        <p className={`muted ${styles.note}`}>Sem conta? Peça um convite ao administrador da organização.</p>
      </div>
    </main>
  )
}
