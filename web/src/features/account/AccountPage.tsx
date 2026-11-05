import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { Trans, useTranslation } from 'react-i18next'
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
import { LocaleSection } from './LocaleSection'

// The signup rule: the server refuses a shorter password (422 on `new_password`).
const MIN_PASSWORD = 12

/** The message of the field the server refused (422), if it is this one. */
function fieldError(error: unknown, field: string): string | null {
  if (!(error instanceof ApiError) || error.status !== 422) return null
  const errors = (error.problem as { errors?: { field: string; message: string }[] } | null)?.errors ?? []
  return errors.find((item) => item.field === field)?.message ?? null
}

/** My settings › Account: the account data, the transcription language, privacy and data, changing the password and deleting the account. */
export function AccountPage() {
  useHelpTopic('conta')
  const { t } = useTranslation('account')
  const me = useMe()
  const [deleting, setDeleting] = useState(false)
  const user = me.data?.user

  return (
    <section className={styles.page}>
      <PageHead kicker={t('page.kicker')} title={t('page.title')} />
      {user && (
        <dl className={styles.identity}>
          <dt>{t('page.name')}</dt>
          <dd>{user.name}</dd>
          <dt>{t('page.email')}</dt>
          <dd className="mono">{user.email}</dd>
        </dl>
      )}

      <LocaleSection />

      <TranscriptionSection />

      <AudioRetentionCard />

      <PrivacySection />

      <PasswordSection />

      <section className={`panel ${styles.danger}`} aria-labelledby="excluir-conta">
        <h4 id="excluir-conta">{t('delete.title')}</h4>
        <div className="alert alert-error">
          <p>
            <Trans t={t} i18nKey="delete.warning" components={{ strong: <strong /> }} />
          </p>
          <p>{t('delete.noUndo')}</p>
        </div>
        <div>
          <button type="button" className="btn btn-danger" onClick={() => setDeleting(true)}>
            {t('delete.open')}
          </button>
        </div>
      </section>

      {deleting && <DeleteAccountDialog onClose={() => setDeleting(false)} />}
    </section>
  )
}

/** The language this account's recordings are transcribed in when the file does not choose another. */
function TranscriptionSection() {
  const { t } = useTranslation('account')
  const id = useId()
  const preference = useTranscriptionPreference()
  const update = useUpdateTranscriptionPreference()

  return (
    <section className={`panel ${styles.form}`} aria-labelledby={`${id}-titulo`}>
      <h4 id={`${id}-titulo`}>{t('transcription.title')}</h4>
      {preference.data && (
        <div className="field">
          <label htmlFor={id}>{t('transcription.label')}</label>
          <LanguageSelect
            id={id}
            value={update.isPending ? (update.variables ?? '') : (preference.data.language ?? '')}
            defaultLabel={serverDefaultLabel(preference.data)}
            disabled={update.isPending}
            onChange={(value) => update.mutate(value === '' ? null : value)}
          />
          <span className="field-hint">
            {t('transcription.hint')}
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

/** Where each piece of data goes, per this server's configuration, and the voice the account keeps. */
function PrivacySection() {
  const { t } = useTranslation('account')
  const privacy = usePrivacy()
  const voice = useVoiceAssignment()

  return (
    <section className={`panel ${styles.form}`} aria-labelledby="privacidade">
      <h4 id="privacidade">{t('privacy.title')}</h4>
      <dl className={styles.identity}>
        <div className={styles.row}>
          <dt>{t('privacy.audio')}</dt>
          <dd>{t('privacy.audioKept')}</dd>
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
        {t('privacy.processors')}
      </p>
      {voice.data && <VoiceKeep assignment={voice.data} />}
    </section>
  )
}

function VoiceKeep({ assignment }: { assignment: VoiceAssignment }) {
  const update = useUpdateVoiceAssignment()
  const [confirming, setConfirming] = useState(false)
  const { t } = useTranslation('account')
  const samples = t('voice.samples', { count: assignment.sample_count })

  return (
    <>
      <p>{t('voice.kept', { people: t('voice.people', { count: assignment.voiceprint_people }), samples })}</p>
      {assignment.platform_enabled && (
        <Switch
          checked={assignment.keep_samples}
          disabled={update.isPending}
          onChange={(keep) => (keep ? update.mutate({ keep_samples: true }) : setConfirming(true))}
        >
          {t('voice.keep')}
        </Switch>
      )}
      {!assignment.keep_samples && (
        <p className="text-muted">
          {t('voice.notKept')}
        </p>
      )}
      {update.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(update.error)}
        </p>
      )}
      {confirming && (
        <ConfirmDialog
          title={t('voice.confirmTitle')}
          confirmLabel={t('voice.confirmLabel')}
          busy={update.isPending}
          onCancel={() => setConfirming(false)}
          onConfirm={() => update.mutate({ keep_samples: false }, { onSettled: () => setConfirming(false) })}
        >
          {t('voice.confirmText', { samples })}
        </ConfirmDialog>
      )}
    </>
  )
}

function PasswordSection() {
  const { t } = useTranslation('account')
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
      <h4 id={`${id}-titulo`}>{t('password.title')}</h4>
      <div className="field">
        <label htmlFor={`${id}-atual`}>{t('password.current')}</label>
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
            {t('password.currentWrong')}
          </span>
        )}
      </div>
      <div className="field">
        <label htmlFor={`${id}-nova`}>{t('password.next')}</label>
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
          {nextError ?? t('password.nextHint', { min: MIN_PASSWORD })}
        </span>
      </div>
      <div className="field">
        <label htmlFor={`${id}-repetir`}>{t('password.repeat')}</label>
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
            {t('password.mismatch')}
          </span>
        )}
      </div>
      <label className="check">
        <input type="checkbox" checked={revokeTokens} onChange={(event) => setRevokeTokens(event.target.checked)} />
        <span className="box" />
        <span>{t('password.revoke')}</span>
      </label>
      {otherError && (
        <p className="alert alert-error" role="alert">
          {otherError}
        </p>
      )}
      {done && (
        <p className="alert alert-success" role="status">
          {done === 'all'
            ? t('password.doneAll')
            : t('password.doneSessions')}
        </p>
      )}
      <div>
        <button type="submit" className="btn btn-primary" disabled={!canSubmit}>
          {change.isPending ? t('password.submitting') : t('password.submit')}
        </button>
      </div>
    </form>
  )
}

function DeleteAccountDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('account')
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
      navigate('/entrar', { replace: true, state: { notice: t('delete.done') } })
    },
  })
  const wrongPassword = fieldError(remove.error, 'password')
  const canDelete = password !== '' && understood && !remove.isPending

  return (
    <Dialog
      plain
      title={t('delete.dialogTitle')}
      message={t('delete.dialogMessage')}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            {t('delete.keep')}
          </button>
          <button type="button" className="btn btn-danger" disabled={!canDelete} onClick={() => remove.mutate()}>
            {remove.isPending ? t('delete.submitting') : t('delete.submit')}
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor={`${id}-senha`}>{t('delete.password')}</label>
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
            {t('delete.passwordWrong')}
          </span>
        )}
      </div>
      <label className="check">
        <input type="checkbox" checked={understood} onChange={(event) => setUnderstood(event.target.checked)} />
        <span className="box" />
        <span>{t('delete.understood')}</span>
      </label>
      {remove.isError && !wrongPassword && (
        <p className="alert alert-error" role="alert">
          {errorMessage(remove.error)}
        </p>
      )}
    </Dialog>
  )
}
