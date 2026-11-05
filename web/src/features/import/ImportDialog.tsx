import { Upload, X } from 'lucide-react'
import { useId, useState, type DragEvent } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { Dialog } from '../../app/Dialog'
import { accountDefaultLabel, useTranscriptionPreference } from '../../app/transcriptionLanguage'
import { LanguageSelect } from '../../shared/LanguageSelect'
import { checkEnvironment } from '../../lib/media-convert'

import styles from './ImportDialog.module.css'
import { useImportContext } from './importContext'
import type { ImportDate, ImportItem } from './useImportQueue'
import { deviceStateLabel, formatBytes } from '../../shared/format'
import { enableNotifyOutcomes, notifyOutcomesOn, notifyPermission, type NotifyPermission } from '../../app/preferences'

const SOURCES: readonly ImportDate['source'][] = ['metadata', 'metadata_day', 'file_date', 'user']

/** "47:12", "1:05:09". */
function clockDuration(seconds: number | null | undefined): string {
  if (seconds == null) return '—'
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

// What the screen reader announces: only the state change, not every progress point.
const ANNOUNCED = ['converting', 'uploading', 'done', 'error', 'canceled'] as const
type Announced = (typeof ANNOUNCED)[number]
const isAnnounced = (kind: ImportItem['state']['kind']): kind is Announced => (ANNOUNCED as readonly string[]).includes(kind)

/**
 * On the uploaded row, the offer to turn on the browser notification (a gesture, never on load). It goes away
 * when the notification is already on or the API is missing; when denied, it says where to allow it.
 */
function NotifyOffer() {
  const { t } = useTranslation('import')
  const [permission, setPermission] = useState<NotifyPermission | 'on'>(() =>
    notifyOutcomesOn() ? 'on' : notifyPermission(),
  )
  if (permission === 'on' || permission === 'unsupported') return null
  if (permission === 'denied') return <>{t('notify.blocked')}</>
  return (
    <>
      {' · '}
      <button
        type="button"
        className={styles.linkButton}
        onClick={() => void enableNotifyOutcomes().then((next) => setPermission(next === 'granted' ? 'on' : next))}
      >
        {t('notify.offer')}
      </button>
    </>
  )
}

function Status({ item, onRetry }: { item: ImportItem; onRetry: () => void }) {
  const { t } = useTranslation(['import', 'common'])
  const { state } = item
  switch (state.kind) {
    case 'reading':
      return <>{t('status.reading')}</>
    case 'ready':
      return <>{t('status.ready')}</>
    case 'converting':
      return <>{t('status.converting', { percent: Math.round(state.ratio * 100) })}</>
    case 'uploading':
      return state.progress && state.progress.partsTotal > 0 ? (
        <>
          {t('status.uploadingPart', {
            current: Math.min(state.progress.partsDone + 1, state.progress.partsTotal),
            total: state.progress.partsTotal,
          })}
        </>
      ) : (
        <>{t('status.uploading')}</>
      )
    case 'done':
      return (
        <>
          {state.deduplicated ? t('status.duplicate') : t('status.done')} ·{' '}
          <Link to={`/gravacoes/${state.recordingId}`}>{t('status.open')}</Link>
          {!state.deduplicated && <NotifyOffer />}
        </>
      )
    case 'error':
      return (
        <span className={styles.error}>
          {t('status.error', { state: deviceStateLabel('failed'), message: state.message })} ·{' '}
          <button type="button" className={styles.linkButton} onClick={onRetry}>
            {t('common:retry')}
          </button>
        </span>
      )
    case 'canceled':
      return <>{t('status.canceled')}</>
  }
}

function Row({ item, defaultLanguage }: { item: ImportItem; defaultLanguage: string }) {
  const { t } = useTranslation('import')
  const queue = useImportContext()
  const sourceId = useId()
  const busy = item.state.kind === 'converting' || item.state.kind === 'uploading'
  // The date and the language go only when the upload is created: once created, retrying resumes the same one and does not resend them.
  const editable =
    item.state.kind === 'reading' || item.state.kind === 'ready' || (item.state.kind === 'error' && !item.state.resumable)
  const removable = editable || item.state.kind === 'error'
  const warn = item.date.source === 'file_date' || item.date.source === 'metadata_day'
  return (
    <tr>
      <td>
        <strong className={styles.name}>{item.file.name}</strong>
        <div className="text-muted">{formatBytes(item.file.size)}</div>
      </td>
      <td>
        <input
          className={`input mono ${styles.date}`}
          type="datetime-local"
          step={60}
          required
          value={item.date.value}
          disabled={!editable}
          aria-label={t('row.start', { name: item.file.name })}
          aria-describedby={sourceId}
          aria-invalid={!item.date.value || undefined}
          data-warning={warn || undefined}
          onChange={(event) => queue.setDate(item.id, event.target.value)}
        />
        <div className="date-source" id={sourceId} data-warning={warn || undefined}>
          {item.state.kind === 'reading'
            ? t('row.readingDate')
            : SOURCES.includes(item.date.source)
              ? t(`source.${item.date.source}`)
              : item.date.source}
        </div>
      </td>
      <td>
        <LanguageSelect
          className={`input ${styles.language}`}
          label={t('row.language', { name: item.file.name })}
          value={item.language ?? ''}
          defaultLabel={defaultLanguage}
          disabled={!editable}
          onChange={(language) => queue.edit(item.id, (current) => ({ ...current, language: language || undefined }))}
        />
      </td>
      <td className="tabular">{clockDuration(item.probe?.durationSec)}</td>
      <td>
        <Status item={item} onRetry={() => queue.retry(item.id)} />
        <span className="visually-hidden" aria-live="polite">
          {isAnnounced(item.state.kind) &&
            t('announce', { name: item.file.name, state: t(`announced.${item.state.kind}`) })}
        </span>
      </td>
      <td>
        {(busy || removable || item.state.kind === 'canceled') && (
          <button
            type="button"
            className={`btn btn-ghost btn-icon ${styles.remove}`}
            aria-label={busy ? t('row.cancel', { name: item.file.name }) : t('row.remove', { name: item.file.name })}
            onClick={() => (busy ? queue.cancel(item.id) : queue.remove(item.id))}
          >
            <X size={16} aria-hidden />
          </button>
        )}
      </td>
    </tr>
  )
}

/**
 * The Import modal over the library (frame "Import files"): the drop zone and the table with the start
 * of the recording and the language of each file, confirmed before upload. Closing during upload only hides the modal.
 */
export function ImportDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation(['import', 'common'])
  const queue = useImportContext()
  const preference = useTranscriptionPreference()
  const defaultLanguage = preference.data ? accountDefaultLabel(preference.data) : t('dialog.accountDefault')
  const environment = checkEnvironment()
  const blocked = !environment.secureContext || !environment.subtleCrypto
  const [over, setOver] = useState(false)
  const ready = queue.items.filter((item) => item.state.kind === 'ready')
  const reading = queue.items.some((item) => item.state.kind === 'reading')
  const missingDate = ready.some((item) => !item.date.value)
  const started = queue.items.some((item) => item.state.kind !== 'reading' && item.state.kind !== 'ready')

  function onDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault()
    setOver(false)
    if (!blocked && event.dataTransfer.files.length > 0) queue.add(event.dataTransfer.files)
  }

  /** Cancel discards what was not uploaded; after the upload, Close only hides the modal. */
  function close() {
    if (!started) {
      for (const item of queue.items) queue.remove(item.id)
    } else if (!queue.sending) {
      queue.clearFinished()
    }
    onClose()
  }

  return (
    <Dialog
      title={t('dialog.title')}
      kicker={t('dialog.kicker')}
      size="lg"
      plain
      onClose={close}
      actions={
        <>
          <button type="button" className="btn btn-secondary" onClick={close}>
            {started ? t('dialog.close') : t('common:cancel')}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={blocked || ready.length === 0 || reading || missingDate}
            onClick={queue.send}
          >
            {ready.length === 0 ? t('dialog.sendNone') : t('dialog.send', { count: ready.length })}
          </button>
        </>
      }
    >
      <div className={styles.body}>
        {blocked && (
          <p className="alert alert-error" role="alert">
            <Trans t={t} i18nKey="dialog.insecure" components={{ b: <strong /> }} />
          </p>
        )}
        {!blocked && !environment.webCodecs && (
          <p className="alert alert-warning">
            {t('dialog.noWebCodecs')}
          </p>
        )}
        <label
          className={`dropzone ${styles.dropzone}`}
          data-over={over || undefined}
          aria-disabled={blocked || undefined}
          onDragOver={(event) => {
            event.preventDefault()
            setOver(true)
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
        >
          <Upload size={20} aria-hidden />
          <strong>{t('dialog.drop')}</strong>
          <span className="text-muted">
            <Trans t={t} i18nKey="dialog.choose" components={{ choose: <span className={styles.choose} /> }} />
          </span>
          <input
            type="file"
            multiple
            accept="audio/*,video/*"
            className="visually-hidden"
            disabled={blocked}
            onChange={(event) => {
              if (event.target.files) queue.add(event.target.files)
              event.target.value = ''
            }}
          />
        </label>
        {queue.items.length > 0 && (
          <div className={styles.tableScroll}>
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">{t('table.file')}</th>
                  <th scope="col">{t('table.start')}</th>
                  <th scope="col">{t('table.language')}</th>
                  <th scope="col">{t('table.duration')}</th>
                  <th scope="col">{t('table.status')}</th>
                  <th scope="col">
                    <span className="visually-hidden">{t('table.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {queue.items.map((item) => (
                  <Row key={item.id} item={item} defaultLanguage={defaultLanguage} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Dialog>
  )
}
