import { useQueryClient } from '@tanstack/react-query'
import { useId, useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate } from 'react-router'
import { api } from '../../api/client'
import { ApiError, errorMessage, unwrap } from '../../api/problem'
import { externalDestinations, usePrivacy, type PrivacyInfo } from '../../app/privacy'
import { refreshSession, useMe } from '../../app/session'
import { usePageTitle } from '../../app/usePageTitle'
import { AuthLayout } from './AuthLayout'
import { MIN_PASSWORD, useSignupInfo } from './signup'

const CLOSED = 'O cadastro está fechado neste servidor. Peça uma conta a quem o administra.'

/** The line before the acceptance: the summaries and the chat that leave the server, and to whom; `null` if nothing leaves. */
function signupDestinationLine(info: PrivacyInfo | undefined): string | null {
  const outside = externalDestinations(info).filter((d) => d.purpose === 'summaries' || d.purpose === 'chat')
  if (outside.length === 0) return null
  const what = outside.length === 2 ? 'os resumos e o chat' : outside[0].purpose === 'chat' ? 'o chat' : 'os resumos'
  const who = [...new Set(outside.map((d) => d.processor ?? 'um serviço externo'))].join(' e ')
  return `Neste servidor, ${what} são feitos fora dele, por ${who}: o texto das transcrições vai para lá. O áudio e as transcrições ficam guardados aqui.`
}

/** "a, b e c" ("a, b and c"). */
function joinMissing(labels: string[]): string {
  return labels.length > 1 ? `${labels.slice(0, -1).join(', ')} e ${labels[labels.length - 1]}` : labels[0]
}

/** Criar conta (`/cadastro`): open signup, with the mandatory acceptance of the notice in force. */
export function SignupPage() {
  usePageTitle('Criar conta')
  const me = useMe()
  const info = useSignupInfo()
  const destinationLine = signupDestinationLine(usePrivacy().data)
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [accepted, setAccepted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [triedSubmit, setTriedSubmit] = useState(false)
  const ids = {
    name: useId(),
    email: useId(),
    password: useId(),
    hint: useId(),
    accepted: useId(),
    error: useId(),
    missing: useId(),
  }

  if (me.data) return <Navigate to="/" replace />

  const notice = info.data?.notice
  // What is missing, in form order: the button stays active and, on submit, says this and focuses the first one.
  const missing = [
    name.trim() === '' && { id: ids.name, label: 'o nome' },
    email.trim() === '' && { id: ids.email, label: 'o e-mail' },
    password.length < MIN_PASSWORD && { id: ids.password, label: `a senha com ${MIN_PASSWORD} caracteres` },
    !accepted && { id: ids.accepted, label: 'o aceite do aviso' },
  ].filter((item) => item !== false)
  const showMissing = triedSubmit && missing.length > 0

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (missing.length > 0) {
      setTriedSubmit(true)
      document.getElementById(missing[0].id)?.focus()
      return
    }
    if (!notice) return
    setError(null)
    setSubmitting(true)
    try {
      await unwrap(
        api.POST('/api/v1/auth/signup', {
          body: { name: name.trim(), email: email.trim(), password, notice_version: notice.version },
        }),
      )
      // The response opens the session, like the login.
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
        {destinationLine && <p className="field-hint">{destinationLine}</p>}
        <div className="panel">
          <label className="check">
            <input
              id={ids.accepted}
              type="checkbox"
              required
              checked={accepted}
              onChange={(e) => setAccepted(e.target.checked)}
            />
            <span className="box" />
            <span>{notice?.text}</span>
          </label>
        </div>
        {error && (
          <p id={ids.error} className="alert alert-error" role="alert">
            {error}
          </p>
        )}
        {showMissing && (
          <p id={ids.missing} className="alert alert-error" role="alert">
            Para criar a conta, falta {joinMissing(missing.map((item) => item.label))}.
          </p>
        )}
        <button
          type="submit"
          className="btn btn-primary btn-block"
          disabled={submitting}
          aria-describedby={showMissing ? ids.missing : undefined}
        >
          {submitting ? 'Criando…' : 'Criar conta'}
        </button>
        {back}
      </form>
    </AuthLayout>
  )
}
