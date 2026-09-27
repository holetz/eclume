import { useQueryClient } from '@tanstack/react-query'
import { useId, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { api } from '../../api/client'
import { ApiError, errorMessage, unwrap } from '../../api/problem'
import { ME_KEY, useMe } from '../../app/session'
import { usePageTitle } from '../../app/usePageTitle'
import { MIN_PASSWORD } from './invitation'
import { AuthLayout } from './AuthLayout'

/** Aceite do convite (`/convite/:token`): cria a conta e entra, sem sessão prévia. */
export function InvitationPage() {
  usePageTitle('Aceitar convite')
  const { token = '' } = useParams()
  const me = useMe()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const errorId = useId()
  const hintId = useId()

  const mismatch = confirmation.length > 0 && confirmation !== password
  const ready = name.trim() && password.length >= MIN_PASSWORD && confirmation === password

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ready) return
    setError(null)
    setSubmitting(true)
    try {
      await unwrap(
        api.POST('/api/v1/auth/invitations/{invitation_token}/accept', {
          params: { path: { invitation_token: token } },
          body: { name: name.trim(), password },
        }),
      )
      await queryClient.invalidateQueries({ queryKey: ME_KEY })
      navigate('/', { replace: true })
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.status === 404
          ? 'Este convite é inválido, expirou ou já foi usado. Peça um novo ao administrador.'
          : errorMessage(caught),
      )
      setSubmitting(false)
    }
  }

  return (
    <AuthLayout>
      <div>
        <h2>Aceitar convite</h2>
        {me.data ? (
          <p className="alert alert-info">
            Você já está conectado como {me.data.user.name}. Para aceitar este convite com outra conta, saia primeiro.{' '}
            <Link to="/">Ir para a biblioteca</Link>.
          </p>
        ) : (
          <>
            <p className="text-muted">Escolha seu nome e uma senha para criar a conta na organização.</p>
            <form onSubmit={submit} noValidate>
              <div className="field">
                <label htmlFor="convite-nome">Nome</label>
                <input
                  id="convite-nome"
                  className="input"
                  autoComplete="name"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="convite-senha">Senha</label>
                <input
                  id="convite-senha"
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={MIN_PASSWORD}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  aria-describedby={hintId}
                />
                <span id={hintId} className="field-hint">
                  Ao menos {MIN_PASSWORD} caracteres.
                </span>
              </div>
              <div className="field">
                <label htmlFor="convite-confirmacao">Confirme a senha</label>
                <input
                  id="convite-confirmacao"
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  required
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
                  aria-invalid={mismatch}
                />
                {mismatch && <span className="field-hint">As senhas não conferem.</span>}
              </div>
              {error && (
                <p id={errorId} className="alert alert-error" role="alert">
                  {error}
                </p>
              )}
              <button type="submit" className="btn btn-primary" disabled={submitting || !ready}>
                {submitting ? 'Criando a conta…' : 'Criar conta e entrar'}
              </button>
            </form>
          </>
        )}
      </div>
    </AuthLayout>
  )
}
