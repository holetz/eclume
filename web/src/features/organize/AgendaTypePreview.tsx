// "Pré-visualizar numa gravação": the draft agenda type on a transcribed recording (detection, title,
// tags and summary), without saving anything.
import { useQuery } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Markdown from 'react-markdown'
import { SAFE_MARKDOWN } from '../../app/markdown'
import { api, type Schemas } from '../../api/client'
import { errorMessage, unwrap } from '../../api/problem'
import { Dialog } from '../../app/Dialog'
import { i18n } from '../../i18n'

import styles from './Organize.module.css'
import { agendaPreviewResult, type PreviewRun } from './usePreview'
import { formatDate } from '../../shared/format'

const RECENT = 20

function useTranscribedRecordings() {
  return useQuery({
    queryKey: ['recordings', { status: ['transcribed'], sort: 'recorded_desc', limit: RECENT }],
    queryFn: () => unwrap(api.GET('/api/v1/recordings', { params: { query: { status: ['transcribed'], sort: 'recorded_desc', limit: RECENT } } })),
  })
}

/** The dialog that chooses among the 20 most recent transcribed recordings. */
export function RecordingPicker({ onPick, onClose }: { onPick: (recordingId: string) => void; onClose: () => void }) {
  const { t } = useTranslation(['organize', 'common'])
  const id = useId()
  const recordings = useTranscribedRecordings()
  const items = recordings.data?.items ?? []
  const [chosen, setChosen] = useState<string | null>(null)
  const value = chosen ?? items[0]?.id ?? ''

  return (
    <Dialog
      plain
      title={t('preview.title')}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            {t('common:cancel')}
          </button>
          <button type="button" className="btn btn-primary" disabled={!value} onClick={() => onPick(value)}>
            {t('preview.submit')}
          </button>
        </>
      }
    >
      <div className={styles.pickerBody}>
        {recordings.isPending && <p role="status">{t('preview.loading')}</p>}
        {recordings.isError && (
          <p className="alert alert-error" role="alert">
            {errorMessage(recordings.error)}
          </p>
        )}
        {recordings.isSuccess && items.length === 0 && <p>{t('preview.none')}</p>}
        {items.length > 0 && (
          <div className="field">
            <label htmlFor={`${id}-gravacao`}>{t('preview.recording')}</label>
            <select
              id={`${id}-gravacao`}
              className="input"
              value={value}
              onChange={(event) => setChosen(event.target.value)}
            >
              {items.map((recording) => (
                <option key={recording.id} value={recording.id}>
                  {t('preview.option', { title: recording.title, date: formatDate(recording.recorded_at) })}
                </option>
              ))}
            </select>
            <span className="field-hint">{t('preview.nothingSaved')}</span>
          </div>
        )}
      </div>
    </Dialog>
  )
}

const percent = (confidence: number | null) =>
  confidence === null ? '' : i18n.t('organize:preview.confidence', { percent: Math.round(confidence * 100) })

/** The preview result, or the wait, the failure and the changed-draft notice. */
export function AgendaPreviewResult({
  preview: run,
  stale,
}: {
  preview: PreviewRun<Schemas['AgendaTypePreviewRequest']>
  /** The draft changed since the preview started. */
  stale: boolean
}) {
  const { t } = useTranslation('organize')
  const { state, preview, elapsedMs, error } = run
  if (state === 'idle') return null
  if (stale) {
    return (
      <p className="alert alert-warning" role="status">
        {t('preview.stale')}
      </p>
    )
  }
  if (state === 'queued' || state === 'running') {
    return (
      <p className="alert" role="status">
        <span>
          {t('preview.running')}{' '}
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
        {t('preview.expired')}
      </p>
    )
  }
  const failure = preview?.error
  const item = state === 'done' && preview ? agendaPreviewResult(preview) : null
  if (state === 'failed' || !item) {
    return (
      <p className="alert alert-error" role="alert">
        {failure
          ? failure.code === 'no_provider'
            ? t('preview.noProvider')
            : failure.message
          : state === 'failed'
            ? errorMessage(error)
            : t('preview.empty')}
      </p>
    )
  }

  return (
    <section className={styles.previewResult} aria-label={t('preview.label')}>
      <div className={styles.previewBlock}>
        <span className="kicker">{t('preview.detection', { title: item.recording_title })}</span>
        {item.detected ? (
          <span className="badge badge-success">
            {item.fallback ? t('preview.fallbackStays') : t('preview.chosen')}
            {percent(item.confidence)}
          </span>
        ) : (
          <span className="badge badge-warning">
            {item.fallback ? t('preview.fallbackOther') : t('preview.agentPicks')}
            {'\u00a0'}
            <strong>{item.detected_type_name}</strong>
            {percent(item.confidence)}
          </span>
        )}
      </div>
      <div className={styles.previewBlock}>
        <span className="kicker">{t('preview.titleLabel')}</span>
        <span>{item.title}</span>
      </div>
      <div className={styles.previewBlock}>
        <span className="kicker">{t('preview.tags')}</span>
        {item.tags.length ? (
          <ul className={styles.tags} aria-label={t('preview.tagsLabel')}>
            {item.tags.map((tag) => (
              <li key={tag} className="tag tag-neutral">
                {tag}
              </li>
            ))}
          </ul>
        ) : (
          <span className="text-muted">{t('preview.noTags')}</span>
        )}
      </div>
      <div className={styles.previewBlock}>
        <span className="kicker">{t('preview.summary')}</span>
        <div className="doc">
          <Markdown components={SAFE_MARKDOWN}>{item.summary_md}</Markdown>
        </div>
      </div>
    </section>
  )
}
