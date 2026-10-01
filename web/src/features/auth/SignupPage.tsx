import { useQueryClient } from '@tanstack/react-query'
import { useId, useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate } from 'react-router'
import { api } from '../../api/client'
import { ApiError, errorMessage, unwrap } from '../../api/problem'
import { refreshSession, useMe } from '../../app/session'
import { usePageTitle } from '../../app/usePageTitle'
import { AuthLayout } from './AuthLayout'
import { MIN_PASSWORD, useSignupInfo } from './signup'

const CLOSED = 'O cadastro está fechado neste servidor. Peça uma conta a quem o administra.'

/** Criar conta (`/cadastro`): cadastro aberto, com o aceite obrigatório do aviso em vigor. */
export function SignupPage() {
  usePageTitle('Criar conta')
  const me = useMe()
  const info = useSignupInfo()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [accepted, setAccepted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const ids = { name: useId(), email: useId(), password: useId(), hint: useId(), error: useId() }

  if (me.data) return <Navigate to="/" replace />

  const notice = info.data?.notice
  const ready = Boolean(notice) && name.trim() !== '' && email.trim() !== '' && password.length >= MIN_PASSWORD && accepted

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ready || !notice) return
    setError(null)
    setSubmitting(true)
    try {
      await unwrap(
        api.POST('/api/v1/auth/signup', {
          body: { name: name.trim(), email: email.trim(), password, notice_version: notice.version },
        }),
      )
      // A resposta abre a sessão, como o login.
      await refreshSession(queryClient)
      navigate('/', { replace: true })
    } catch (caught) {
      const code = caught instanceof ApiError ? caught.code : null
      setError(
        code === 'email_taken'
          ? 'Já existe uma conta com este e-mail.'
          : code === 'signup_closed'
            ? CLOSED
            : errorMessage(caught),
      )
      setSubmitting(false)
    }
  }

  const back = (
    <p className="text-muted auth-note">
      Já tem conta? <Link to="/entrar">Entrar</Link>
    </p>
  )

  if (info.isPending) {
    return (
      <AuthLayout>
        <p role="status">Carregando…</p>
      </AuthLayout>
    )
  }
  if (info.isError || !info.data.open) {
    return (
      <AuthLayout>
        <div>
          <h2>Criar sua conta</h2>
          <p className="alert alert-error" role="alert">
            {info.isError ? errorMessage(info.error) : CLOSED}
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
          <h2>Criar sua conta</h2>
          <p className="text-muted">Seu espaço fica pronto assim que você se cadastra.</p>
        </div>
        <div className="field">
          <label htmlFor={ids.name}>Nome</label>
          <input
            id={ids.name}
            className="input"
            autoComplete="name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={ids.email}>E-mail</label>
          <input
            id={ids.email}
            className="input"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-describedby={error ? ids.error : undefined}
          />
        </div>
        <div className="field">
          <label htmlFor={ids.password}>Senha</label>
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
        <div className="panel">
          <label className="check">
            <input type="checkbox" required checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
            <span className="box" />
            <span>{notice?.text}</span>
          </label>
        </div>
        {error && (
          <p id={ids.error} className="alert alert-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn btn-primary btn-block" disabled={submitting || !ready}>
          {submitting ? 'Criando…' : 'Criar conta'}
        </button>
        {back}
      </form>
    </AuthLayout>
  )
}
