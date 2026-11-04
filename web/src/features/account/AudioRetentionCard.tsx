import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useId, useState, type FormEvent } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { api, type Schemas } from '../../api/client'
import { errorMessage, unwrap } from '../../api/problem'
import { Switch } from '../../shared/Switch'
import styles from './Account.module.css'

type AudioRetention = Schemas['AudioRetention']

const KEY = ['me', 'audio-retention'] as const
const DEFAULT_DAYS = 90
const MIN_DAYS = 1
const MAX_DAYS = 3650

/** The account's audio retention and the platform ceiling (`GET /me/audio-retention`). */
function useAudioRetention() {
  return useQuery({ queryKey: KEY, queryFn: () => unwrap(api.GET('/api/v1/me/audio-retention')) })
}

function useUpdateAudioRetention() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (days: number | null) => unwrap(api.PATCH('/api/v1/me/audio-retention', { body: { days } })),
    onSuccess: (updated) => queryClient.setQueryData(KEY, updated),
  })
}

/** How long the server keeps the audio of this account's recordings; the transcript and the summary stay. */
export function AudioRetentionCard() {
  const retention = useAudioRetention()
  return retention.data ? (
    <RetentionForm retention={retention.data} />
  ) : (
    retention.isError && (
      <p className="alert alert-error" role="alert">
        {errorMessage(retention.error)}
      </p>
    )
  )
}

function RetentionForm({ retention }: { retention: AudioRetention }) {
  const { t } = useTranslation(['account', 'common'])
  const id = useId()
  const update = useUpdateAudioRetention()
  const [enabled, setEnabled] = useState(retention.days !== null)
  const [value, setValue] = useState(String(retention.days ?? DEFAULT_DAYS))

  const days = Number(value)
  const valid = Number.isInteger(days) && days >= MIN_DAYS && days <= MAX_DAYS
  const chosen = enabled ? days : null
  const changed = chosen !== retention.days
  const capped = retention.max_days !== null && retention.days !== null && retention.days > retention.max_days

  function submit(event: FormEvent) {
    event.preventDefault()
    if (enabled && !valid) return
    update.mutate(chosen)
  }

  return (
    <form className={`panel ${styles.form}`} aria-labelledby={`${id}-titulo`} onSubmit={submit}>
      <h4 id={`${id}-titulo`}>{t('retention.title')}</h4>
      <p>{t('retention.text')}</p>
      <Switch checked={enabled} onChange={setEnabled} disabled={update.isPending}>
        {t('retention.toggle')}
      </Switch>
      {enabled && (
        <div className="field">
          <label htmlFor={id}>{t('retention.days')}</label>
          <input
            id={id}
            className="input"
            type="number"
            min={MIN_DAYS}
            max={MAX_DAYS}
            step={1}
            value={value}
            aria-invalid={valid ? undefined : true}
            aria-describedby={`${id}-dica`}
            onChange={(e) => setValue(e.target.value)}
          />
          <span id={`${id}-dica`} className={`field-hint ${valid ? '' : styles.error}`}>
            {valid ? t('retention.hint') : t('retention.range', { min: MIN_DAYS, max: MAX_DAYS })}
          </span>
        </div>
      )}
      {retention.max_days !== null && (
        <p className="field-hint">
          {t('retention.capped', { days: retention.max_days })}
          {capped && t('retention.effective', { days: String(retention.effective_days) })}
        </p>
      )}
      <div className="alert alert-error">
        <p>
          <Trans t={t} i18nKey="retention.irreversible" components={{ strong: <strong /> }} />
        </p>
        <p>{t('retention.backups')}</p>
      </div>
      {update.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(update.error)}
        </p>
      )}
      {update.isSuccess && !changed && (
        <p className="alert alert-success" role="status">
          {t('retention.saved')}
        </p>
      )}
      <div>
        <button type="submit" className="btn btn-primary" disabled={!changed || (enabled && !valid) || update.isPending}>
          {t('common:save')}
        </button>
      </div>
    </form>
  )
}
