import { useTranslation } from 'react-i18next'
import type { Schemas } from '../../api/client'
import { errorMessage } from '../../api/problem'
import styles from './Organize.module.css'
import { fieldTestRows, type PreviewRun } from './usePreview'

/** The result of "Testar numa gravação": the draft rule on the latest transcribed recordings. */
export function FieldTest({ test }: { test: PreviewRun<Schemas['FieldPreviewRequest']> }) {
  const { t } = useTranslation('organize')
  const { state, preview, elapsedMs, error } = test
  if (state === 'idle') return null

  if (state === 'queued' || state === 'running') {
    return (
      <p className="alert" role="status">
        <span>
          {t('test.running')}{' '}
          <span className="tabular" aria-hidden="true">
            {t('seconds', { seconds: Math.floor(elapsedMs / 1000) })}
          </span>
        </span>
      </p>
    )
  }

  if (state === 'expired') {
    return (
      <p className="alert alert-warning" role="alert">
        {t('test.expired')}
      </p>
    )
  }

  if (state === 'failed') {
    const failure = preview?.error
    return (
      <p className="alert alert-error" role="alert">
        {failure ? (failure.code === 'no_provider' ? t('test.noProvider') : failure.message) : errorMessage(error)}
      </p>
    )
  }

  const rows = preview ? fieldTestRows(preview) : []
  if (rows.length === 0) {
    return (
      <p className="alert" role="status">
        {t('test.none')}
      </p>
    )
  }
  return (
    <div className="alert" role="status">
      <span className="alert-title">
        {t('test.last', { count: rows.length })}
      </span>
      <ul className={styles.testRows} aria-label={t('test.result')}>
        {rows.map((row) => (
          <li key={row.recordingId}>
            {row.recordingTitle} → {row.value === null ? <em>{t('test.empty')}</em> : <strong>{row.value}</strong>}
          </li>
        ))}
      </ul>
    </div>
  )
}
