import { useId, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate, useNavigate, useSearchParams } from 'react-router'
import { ApiError, errorMessage } from '../../api/problem'
import { AuthLayout } from '../auth/AuthLayout'
import { adminReturnPath, useAdminLogin, useAdminMe } from './adminSession'
import { useAdminTitle } from './sections'

/** Admin account login, in the `.auth-admin` variant: no signup nor "esqueci a senha" (that is through the CLI). */
export function AdminSignInPage() {
  const { t } = useTranslation('admin')
  useAdminTitle(t('signIn.tabTitle'))
  const [params] = useSearchParams()
  const returnPath = adminReturnPath(params.get('volta'))
  const me = useAdminMe()
  const login = useAdminLogin()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const errorId = useId()

  if (me.data) return <Navigate to={returnPath} replace />

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    login.mutate({ email: email.trim(), password }, { onSuccess: () => navigate(returnPath, { replace: true }) })
  }

  const error = login.error
    ? login.error instanceof ApiError && login.error.status === 401
      ? t('signIn.wrong')
      : errorMessage(login.error)
    : null

  return (
    <AuthLayout variant="admin">
      <form onSubmit={submit} noValidate>
        <h2>{t('signIn.heading')}</h2>
        <div className="field">
          <label htmlFor="admin-login-email">{t('signIn.email')}</label>
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
          <label htmlFor="admin-login-password">{t('signIn.password')}</label>
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
          {login.isPending ? t('signIn.submitting') : t('signIn.submit')}
        </button>
      </form>
    </AuthLayout>
  )
}
