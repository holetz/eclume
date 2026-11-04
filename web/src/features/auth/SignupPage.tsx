import { useQueryClient } from '@tanstack/react-query'
import { useId, useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate } from 'react-router'
import { api } from '../../api/client'
import { ApiError, errorMessage, unwrap } from '../../api/problem'
import { externalDestinations, usePrivacy, type PrivacyInfo } from '../../app/privacy'
import { refreshSession, useMe } from '../../app/session'
import { usePageTitle } from '../../app/usePageTitle'
import { activeLocale, i18n } from '../../i18n'
import { useTranslation } from 'react-i18next'
import { AuthLayout } from './AuthLayout'
import { MIN_PASSWORD, useSignupInfo } from './signup'

/** "a, b e c", "a, b, and c": the list joined in the active locale. */
function joinList(items: string[]): string {
  return new Intl.ListFormat(activeLocale(), { type: 'conjunction' }).format(items)
}

/** The line before the acceptance: the summaries and the chat that leave the server, and to whom; `null` if nothing leaves. */
function signupDestinationLine(info: PrivacyInfo | undefined): string | null {
  const outside = externalDestinations(info).filter((d) => d.purpose === 'summaries' || d.purpose === 'chat')
  if (outside.length === 0) return null
  const what = outside.length === 2 ? 'both' : outside[0].purpose === 'chat' ? 'chat' : 'summaries'
  const who = joinList([...new Set(outside.map((d) => d.processor ?? i18n.t('auth:signup.destination.unknownProcessor')))])
  return i18n.t(`auth:signup.destination.${what}`, { who })
}

/** Create an account (`/cadastro`): open signup, with the mandatory acceptance of the notice in force. */
export function SignupPage() {
  const { t } = useTranslation(['auth', 'common'])
  usePageTitle(t('signup.pageTitle'))
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
    name.trim() === '' && { id: ids.name, label: t('signup.missingName') },
    email.trim() === '' && { id: ids.email, label: t('signup.missingEmail') },
    password.length < MIN_PASSWORD && { id: ids.password, label: t('signup.missingPassword', { min: MIN_PASSWORD }) },
    !accepted && { id: ids.accepted, label: t('signup.missingAccepted') },
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
          ? t('signup.emailTaken')
          : code === 'signup_closed'
            ? t('signup.closed')
            : errorMessage(caught),
      )
      setSubmitting(false)
    }
  }

  const back = (
    <p className="text-muted auth-note">
      {t('signup.haveAccount')} <Link to="/entrar">{t('signup.login')}</Link>
    </p>
  )

  if (info.isPending) {
    return (
      <AuthLayout>
        <p role="status">{t('common:loading')}</p>
      </AuthLayout>
    )
  }
  if (info.isError || !info.data.open) {
    return (
      <AuthLayout>
        <div>
          <h2>{t('signup.title')}</h2>
          <p className="alert alert-error" role="alert">
            {info.isError ? errorMessage(info.error) : t('signup.closed')}
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
          <h2>{t('signup.title')}</h2>
          <p className="text-muted">{t('signup.text')}</p>
        </div>
        <div className="field">
          <label htmlFor={ids.name}>{t('signup.name')}</label>
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
          <label htmlFor={ids.email}>{t('email')}</label>
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
          <label htmlFor={ids.password}>{t('password')}</label>
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
            {t('passwordHint', { min: MIN_PASSWORD })}
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
            {t('signup.missing', { items: joinList(missing.map((item) => item.label)) })}
          </p>
        )}
        <button
          type="submit"
          className="btn btn-primary btn-block"
          disabled={submitting}
          aria-describedby={showMissing ? ids.missing : undefined}
        >
          {submitting ? t('signup.submitting') : t('signup.submit')}
        </button>
        {back}
      </form>
    </AuthLayout>
  )
}
