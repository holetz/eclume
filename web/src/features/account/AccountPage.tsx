import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { api } from '../../api/client'
import { ApiError, errorMessage, unwrap } from '../../api/problem'
import { Dialog } from '../../app/Dialog'
import { useHelpTopic } from '../../app/help'
import { PageHead } from '../../app/PageHead'
import { ME_KEY, useMe } from '../../app/session'
import styles from './Account.module.css'

// A regra do cadastro: o servidor recusa senha mais curta (422 em `new_password`).
const MIN_PASSWORD = 12

/** A mensagem do campo que o servidor recusou (422), se for este. */
function fieldError(error: unknown, field: string): string | null {
  if (!(error instanceof ApiError) || error.status !== 422) return null
  const errors = (error.problem as { errors?: { field: string; message: string }[] } | null)?.errors ?? []
  return errors.find((item) => item.field === field)?.message ?? null
}

/** Minhas configurações › Conta: os dados da conta, trocar a senha e excluir a conta. */
export function AccountPage() {
  useHelpTopic('conta')
  const me = useMe()
  const [deleting, setDeleting] = useState(false)
  const user = me.data?.user

  return (
    <section className={styles.page}>
      <PageHead kicker="Minhas configurações" title="Conta" />
      {user && (
        <dl className={styles.identity}>
          <dt>Nome</dt>
          <dd>{user.name}</dd>
          <dt>E-mail</dt>
          <dd className="mono">{user.email}</dd>
        </dl>
      )}

      <PasswordSection />

      <section className={`panel ${styles.danger}`} aria-labelledby="excluir-conta">
        <h4 id="excluir-conta">Excluir a conta</h4>
        <div className="alert alert-error">
          <p>
            Excluir a conta apaga <strong>para sempre</strong> tudo o que é seu neste servidor: as gravações e os
            áudios, as transcrições, os resumos e as versões deles, as pessoas e as impressões de voz, as coleções,
            as tags, os campos, os tipos de agenda, os tokens e os aparelhos vinculados.
          </p>
          <p>Não há como desfazer. Se quiser guardar algo, exporte as gravações antes.</p>
        </div>
        <div>
          <button type="button" className="btn btn-danger" onClick={() => setDeleting(true)}>
            Excluir minha conta
          </button>
        </div>
      </section>

      {deleting && <DeleteAccountDialog onClose={() => setDeleting(false)} />}
    </section>
  )
}

function PasswordSection() {
  const id = useId()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [repeat, setRepeat] = useState('')
  const [done, setDone] = useState(false)
  const change = useMutation({
    mutationFn: () =>
      unwrap(api.POST('/api/v1/me/password', { body: { current_password: current, new_password: next } })),
    onSuccess: () => {
      setCurrent('')
      setNext('')
      setRepeat('')
      setDone(true)
    },
  })
  const mismatch = repeat !== '' && next !== repeat
  const tooShort = next !== '' && next.length < MIN_PASSWORD
  const currentError = fieldError(change.error, 'current_password')
  const nextError = fieldError(change.error, 'new_password')
  const otherError = change.isError && !currentError && !nextError ? errorMessage(change.error) : null
  const canSubmit = current !== '' && next.length >= MIN_PASSWORD && next === repeat && !change.isPending

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!canSubmit) return
    setDone(false)
    change.mutate()
  }

  return (
    <form className={`panel ${styles.form}`} onSubmit={submit} aria-labelledby={`${id}-titulo`}>
      <h4 id={`${id}-titulo`}>Trocar a senha</h4>
      <div className="field">
        <label htmlFor={`${id}-atual`}>Senha atual</label>
        <input
          id={`${id}-atual`}
          className="input"
          type="password"
          autoComplete="current-password"
          value={current}
          aria-invalid={currentError ? true : undefined}
          aria-describedby={currentError ? `${id}-atual-erro` : undefined}
          onChange={(event) => setCurrent(event.target.value)}
        />
        {currentError && (
          <span id={`${id}-atual-erro`} className={`field-hint ${styles.error}`}>
            A senha atual não confere.
          </span>
        )}
      </div>
      <div className="field">
        <label htmlFor={`${id}-nova`}>Nova senha</label>
        <input
          id={`${id}-nova`}
          className="input"
          type="password"
          autoComplete="new-password"
          value={next}
          aria-invalid={tooShort || nextError ? true : undefined}
          aria-describedby={`${id}-nova-dica`}
          onChange={(event) => setNext(event.target.value)}
        />
        <span id={`${id}-nova-dica`} className={tooShort || nextError ? `field-hint ${styles.error}` : 'field-hint'}>
          {nextError ?? `Ao menos ${MIN_PASSWORD} caracteres.`}
        </span>
      </div>
      <div className="field">
        <label htmlFor={`${id}-repetir`}>Repita a nova senha</label>
        <input
          id={`${id}-repetir`}
          className="input"
          type="password"
          autoComplete="new-password"
          value={repeat}
          aria-invalid={mismatch || undefined}
          aria-describedby={mismatch ? `${id}-repetir-erro` : undefined}
          onChange={(event) => setRepeat(event.target.value)}
        />
        {mismatch && (
          <span id={`${id}-repetir-erro`} className={`field-hint ${styles.error}`}>
            As duas senhas não são iguais.
          </span>
        )}
      </div>
      {otherError && (
        <p className="alert alert-error" role="alert">
          {otherError}
        </p>
      )}
      {done && (
        <p className="alert alert-success" role="status">
          Senha trocada. As outras sessões abertas desta conta foram encerradas.
        </p>
      )}
      <div>
        <button type="submit" className="btn btn-primary" disabled={!canSubmit}>
          {change.isPending ? 'Trocando…' : 'Trocar a senha'}
        </button>
      </div>
    </form>
  )
}

function DeleteAccountDialog({ onClose }: { onClose: () => void }) {
  const id = useId()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const [understood, setUnderstood] = useState(false)
  const remove = useMutation({
    mutationFn: () => unwrap(api.POST('/api/v1/me/delete', { body: { password } })),
    onSuccess: () => {
      queryClient.removeQueries()
      queryClient.setQueryData(ME_KEY, null)
      navigate('/entrar', { replace: true, state: { notice: 'Sua conta foi excluída, com todos os dados dela.' } })
    },
  })
  const wrongPassword = fieldError(remove.error, 'password')
  const canDelete = password !== '' && understood && !remove.isPending

  return (
    <Dialog
      plain
      title="Excluir a conta?"
      message="Tudo o que é seu neste servidor será apagado agora, sem como desfazer."
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Manter a conta
          </button>
          <button type="button" className="btn btn-danger" disabled={!canDelete} onClick={() => remove.mutate()}>
            {remove.isPending ? 'Excluindo…' : 'Excluir minha conta'}
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor={`${id}-senha`}>Sua senha</label>
        <input
          id={`${id}-senha`}
          className="input"
          type="password"
          autoComplete="current-password"
          value={password}
          aria-invalid={wrongPassword ? true : undefined}
          aria-describedby={wrongPassword ? `${id}-senha-erro` : undefined}
          onChange={(event) => setPassword(event.target.value)}
        />
        {wrongPassword && (
          <span id={`${id}-senha-erro`} className={`field-hint ${styles.error}`}>
            A senha não confere.
          </span>
        )}
      </div>
      <label className="check">
        <input type="checkbox" checked={understood} onChange={(event) => setUnderstood(event.target.checked)} />
        <span className="box" />
        <span>Entendo que tudo será apagado para sempre</span>
      </label>
      {remove.isError && !wrongPassword && (
        <p className="alert alert-error" role="alert">
          {errorMessage(remove.error)}
        </p>
      )}
    </Dialog>
  )
}
