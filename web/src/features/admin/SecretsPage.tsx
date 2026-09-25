import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, useState, type FormEvent } from 'react'
import { api, type Schemas } from '../../api/client'
import { errorMessage, unwrap } from '../../api/problem'
import { usePageTitle } from '../../app/usePageTitle'
import { formatDateTime } from '../library/format'
import styles from './Admin.module.css'
import { SECRET_INFO } from './labels'
import { SECRETS_KEY, useSecrets } from './queries'
import { sectionTitle } from './sections'

type Secret = Schemas['SecretList']['items'][number]

/** Segredos da organização: só escrita. O valor salvo nunca volta do servidor. */
export function SecretsPage() {
  usePageTitle(sectionTitle('segredos'))
  const secrets = useSecrets()
  return (
    <section className={styles.page} aria-labelledby="segredos-titulo">
      <div className={styles.intro}>
        <h2 id="segredos-titulo">Segredos</h2>
        <p className="muted">
          Guardados cifrados no servidor. Depois de salvos, não aparecem mais aqui: para trocar, grave um valor novo.
        </p>
      </div>
      {secrets.isPending && <p role="status">Carregando segredos…</p>}
      {secrets.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(secrets.error)}
        </p>
      )}
      <div className={styles.cards}>
        {secrets.data?.items.map((secret) => (
          <SecretCard key={secret.name} secret={secret} />
        ))}
      </div>
    </section>
  )
}

function SecretCard({ secret }: { secret: Secret }) {
  const queryClient = useQueryClient()
  const [value, setValue] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [notice, setNotice] = useState('')
  const inputId = useId()
  const info = SECRET_INFO[secret.name] ?? { label: secret.name, hint: '' }
  const path = { params: { path: { secret_name: secret.name } } }
  const refresh = () => queryClient.invalidateQueries({ queryKey: SECRETS_KEY })
  const put = useMutation({
    mutationFn: () => unwrap(api.PUT('/api/v1/admin/secrets/{secret_name}', { ...path, body: { value: value.trim() } })),
    onSuccess: async () => {
      setValue('')
      setNotice(`${info.label} salvo.`)
      await refresh()
    },
  })
  const remove = useMutation({
    mutationFn: () => unwrap(api.DELETE('/api/v1/admin/secrets/{secret_name}', path)),
    onSuccess: async () => {
      setConfirming(false)
      setNotice(`${info.label} apagado.`)
      await refresh()
    },
  })
  const failure = put.error ?? remove.error

  function submit(event: FormEvent) {
    event.preventDefault()
    setNotice('')
    if (value.trim()) put.mutate()
  }

  return (
    <form className={`card ${styles.card}`} onSubmit={submit} aria-label={info.label}>
      <h3>{info.label}</h3>
      <p className={styles.meta}>
        {secret.is_set ? (
          <>
            <span className="badge badge-success">Definido</span>
            {secret.updated_at && ` em ${formatDateTime(secret.updated_at)}`}
          </>
        ) : (
          <span className="badge badge-neutral">Não definido</span>
        )}
      </p>
      {info.hint && <p className="hint">{info.hint}</p>}
      <div className="field">
        <label htmlFor={inputId}>{secret.is_set ? 'Novo valor' : 'Valor'}</label>
        <input
          id={inputId}
          className="input"
          type="password"
          autoComplete="off"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </div>
      <div className={styles.actions}>
        <button type="submit" className="btn btn-primary btn-sm" disabled={put.isPending || !value.trim()}>
          {put.isPending ? 'Salvando…' : 'Salvar'}
        </button>
        {secret.is_set &&
          (confirming ? (
            <>
              <button type="button" className="btn btn-danger btn-sm" onClick={() => remove.mutate()} disabled={remove.isPending}>
                Confirmar exclusão
              </button>
              <button type="button" className="btn btn-sm" onClick={() => setConfirming(false)}>
                Manter
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setConfirming(true)}
              aria-label={`Apagar ${info.label}`}
            >
              Apagar
            </button>
          ))}
      </div>
      {failure && (
        <p className={styles.error} role="alert">
          {errorMessage(failure)}
        </p>
      )}
      <p role="status" className={styles.meta}>
        {notice}
      </p>
    </form>
  )
}
