import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { api } from '../../api/client'
import { ApiError, errorMessage, unwrap } from '../../api/problem'
import { ConfirmDialog } from '../../app/ConfirmDialog'
import { Dialog } from '../../app/Dialog'
import { useHelpTopic } from '../../app/help'
import { PageHead } from '../../app/PageHead'
import { locationLabel, PURPOSE_LABEL, usePrivacy } from '../../app/privacy'
import { ME_KEY, useMe } from '../../app/session'
import {
  serverDefaultLabel,
  useTranscriptionPreference,
  useUpdateTranscriptionPreference,
} from '../../app/transcriptionLanguage'
import { LanguageSelect } from '../../shared/LanguageSelect'
import { Switch } from '../../shared/Switch'
import { useUpdateVoiceAssignment, useVoiceAssignment, type VoiceAssignment } from '../people/queries'
import styles from './Account.module.css'
import { AudioRetentionCard } from './AudioRetentionCard'

// The signup rule: the server refuses a shorter password (422 on `new_password`).
const MIN_PASSWORD = 12

/** The message of the field the server refused (422), if it is this one. */
function fieldError(error: unknown, field: string): string | null {
  if (!(error instanceof ApiError) || error.status !== 422) return null
  const errors = (error.problem as { errors?: { field: string; message: string }[] } | null)?.errors ?? []
  return errors.find((item) => item.field === field)?.message ?? null
}

/** Minhas configurações › Conta: the account data, the transcription language, privacy and data, changing the password and deleting the account. */
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

      <TranscriptionSection />

      <AudioRetentionCard />

      <PrivacySection />

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

/** The language this account's recordings are transcribed in when the file does not choose another. */
function TranscriptionSection() {
  const id = useId()
  const preference = useTranscriptionPreference()
  const update = useUpdateTranscriptionPreference()

  return (
    <section className={`panel ${styles.form}`} aria-labelledby={`${id}-titulo`}>
      <h4 id={`${id}-titulo`}>Idioma da transcrição</h4>
      {preference.data && (
        <div className="field">
          <label htmlFor={id}>Idioma das gravações</label>
          <LanguageSelect
            id={id}
            value={update.isPending ? (update.variables ?? '') : (preference.data.language ?? '')}
            defaultLabel={serverDefaultLabel(preference.data)}
            disabled={update.isPending}
            onChange={(value) => update.mutate(value === '' ? null : value)}
          />
          <span className="field-hint">
            Vale para as próximas gravações. Cada arquivo pode pedir outro idioma ao importar, e uma gravação pode ser
            transcrita de novo em outro idioma.
          </span>
        </div>
      )}
      {(preference.isError || update.isError) && (
        <p className="alert alert-error" role="alert">
          {errorMessage(preference.error ?? update.error)}
        </p>
      )}
    </section>
  )
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** Where each piece of data goes, per this server's configuration, and the voice the account keeps. */
function PrivacySection() {
  const privacy = usePrivacy()
  const voice = useVoiceAssignment()

  return (
    <section className={`panel ${styles.form}`} aria-labelledby="privacidade">
      <h4 id="privacidade">Privacidade e dados</h4>
      <dl className={styles.identity}>
        <div className={styles.row}>
          <dt>Áudio e transcrição</dt>
          <dd>Guardados neste servidor</dd>
        </div>
        {privacy.data?.destinations.map((destination) => (
          <div key={destination.purpose} className={styles.row}>
            <dt>{PURPOSE_LABEL[destination.purpose] ?? destination.purpose}</dt>
            <dd>{locationLabel(destination)}</dd>
          </div>
        ))}
      </dl>
      {privacy.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(privacy.error)}
        </p>
      )}
      <p className="text-muted">
        Quem processa os resumos, os campos e o chat é o agente que a administração deste servidor escolheu. Fora do
        servidor, o texto da transcrição vai para esse fornecedor; o áudio não sai.
      </p>
      {voice.data && <VoiceKeep assignment={voice.data} />}
    </section>
  )
}

function VoiceKeep({ assignment }: { assignment: VoiceAssignment }) {
  const update = useUpdateVoiceAssignment()
  const [confirming, setConfirming] = useState(false)
  const kept = `${plural(assignment.voiceprint_people, 'pessoa', 'pessoas')} com impressão de voz, ${plural(
    assignment.sample_count,
    'amostra',
    'amostras',
  )}`

  return (
    <>
      <p>Impressões de voz desta conta: {kept}.</p>
      {assignment.platform_enabled && (
        <Switch
          checked={assignment.keep_samples}
          disabled={update.isPending}
          onChange={(keep) => (keep ? update.mutate({ keep_samples: true }) : setConfirming(true))}
        >
          Guardar amostras de voz desta conta
        </Switch>
      )}
      {!assignment.keep_samples && (
        <p className="text-muted">
          Esta conta não guarda amostras de voz: nada de voz é calculado, comparado ou guardado nas próximas
          gravações.
        </p>
      )}
      {update.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(update.error)}
        </p>
      )}
      {confirming && (
        <ConfirmDialog
          title="Deixar de guardar amostras de voz?"
          confirmLabel="Apagar e deixar de guardar"
          busy={update.isPending}
          onCancel={() => setConfirming(false)}
          onConfirm={() => update.mutate({ keep_samples: false }, { onSettled: () => setConfirming(false) })}
        >
          As {plural(assignment.sample_count, 'amostra', 'amostras')} e as impressões de voz desta conta são apagadas
          agora, com as sugestões de pessoa pela voz. Os locutores já ligados às pessoas continuam ligados. Religar
          depois não recupera o que saiu.
        </ConfirmDialog>
      )}
    </>
  )
}

function PasswordSection() {
  const id = useId()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [repeat, setRepeat] = useState('')
  // Someone changing the password over a suspected leak wants to end all access: checked by default.
  const [revokeTokens, setRevokeTokens] = useState(true)
  const [done, setDone] = useState<'sessions' | 'all' | null>(null)
  const change = useMutation({
    mutationFn: (revoke: boolean) =>
      unwrap(
        api.POST('/api/v1/me/password', {
          body: { current_password: current, new_password: next, revoke_tokens: revoke },
        }),
      ),
    onSuccess: (_, revoke) => {
      setCurrent('')
      setNext('')
      setRepeat('')
      setDone(revoke ? 'all' : 'sessions')
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
    setDone(null)
    change.mutate(revokeTokens)
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
      <label className="check">
        <input type="checkbox" checked={revokeTokens} onChange={(event) => setRevokeTokens(event.target.checked)} />
        <span className="box" />
        <span>Encerrar também aparelhos e tokens</span>
      </label>
      {otherError && (
        <p className="alert alert-error" role="alert">
          {otherError}
        </p>
      )}
      {done && (
        <p className="alert alert-success" role="status">
          {done === 'all'
            ? 'Senha trocada. As outras sessões, os aparelhos ligados e os tokens desta conta foram encerrados.'
            : 'Senha trocada. As outras sessões abertas desta conta foram encerradas.'}
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
