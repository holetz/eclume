// "Pré-visualizar numa gravação": the draft agenda type on a transcribed recording (detection, title,
// tags and summary), without saving anything.
import { useQuery } from '@tanstack/react-query'
import { useId, useState } from 'react'
import Markdown from 'react-markdown'
import { SAFE_MARKDOWN } from '../../app/markdown'
import { api, type Schemas } from '../../api/client'
import { errorMessage, unwrap } from '../../api/problem'
import { Dialog } from '../../app/Dialog'

import styles from './Organize.module.css'
import { agendaPreviewResult, type PreviewRun } from './usePreview'
import { formatDate } from '../../shared/format'

const RECENT = 20
const NO_PROVIDER = 'Nenhum agente está configurado para esta pré-visualização. Peça a quem administra o servidor.'

function useTranscribedRecordings() {
  return useQuery({
    queryKey: ['recordings', { status: ['transcribed'], sort: 'recorded_desc', limit: RECENT }],
    queryFn: () => unwrap(api.GET('/api/v1/recordings', { params: { query: { status: ['transcribed'], sort: 'recorded_desc', limit: RECENT } } })),
  })
}

/** The dialog that chooses among the 20 most recent transcribed recordings. */
export function RecordingPicker({ onPick, onClose }: { onPick: (recordingId: string) => void; onClose: () => void }) {
  const id = useId()
  const recordings = useTranscribedRecordings()
  const items = recordings.data?.items ?? []
  const [chosen, setChosen] = useState<string | null>(null)
  const value = chosen ?? items[0]?.id ?? ''

  return (
    <Dialog
      plain
      title="Pré-visualizar numa gravação"
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancelar
          </button>
          <button type="button" className="btn btn-primary" disabled={!value} onClick={() => onPick(value)}>
            Pré-visualizar
          </button>
        </>
      }
    >
      <div className={styles.pickerBody}>
        {recordings.isPending && <p role="status">Carregando gravações…</p>}
        {recordings.isError && (
          <p className="alert alert-error" role="alert">
            {errorMessage(recordings.error)}
          </p>
        )}
        {recordings.isSuccess && items.length === 0 && <p>Você ainda não tem gravações transcritas para pré-visualizar.</p>}
        {items.length > 0 && (
          <div className="field">
            <label htmlFor={`${id}-gravacao`}>Gravação</label>
            <select
              id={`${id}-gravacao`}
              className="input"
              value={value}
              onChange={(event) => setChosen(event.target.value)}
            >
              {items.map((recording) => (
                <option key={recording.id} value={recording.id}>
                  {recording.title} · {formatDate(recording.recorded_at)}
                </option>
              ))}
            </select>
            <span className="field-hint">Nada é gravado: nem o tipo, nem o resumo, nem a gravação.</span>
          </div>
        )}
      </div>
    </Dialog>
  )
}

const percent = (confidence: number | null) => (confidence === null ? '' : ` (confiança ${Math.round(confidence * 100)}%)`)

/** The preview result, or the wait, the failure and the changed-draft notice. */
export function AgendaPreviewResult({
  preview: run,
  stale,
}: {
  preview: PreviewRun<Schemas['AgendaTypePreviewRequest']>
  /** The draft changed since the preview started. */
  stale: boolean
}) {
  const { state, preview, elapsedMs, error } = run
  if (state === 'idle') return null
  if (stale) {
    return (
      <p className="alert alert-warning" role="status">
        O rascunho mudou desde a pré-visualização.
      </p>
    )
  }
  if (state === 'queued' || state === 'running') {
    return (
      <p className="alert" role="status">
        <span>
          Pré-visualizando na gravação…{' '}
          <span className="tabular" aria-hidden="true">
            {Math.floor(elapsedMs / 1000)} s
          </span>
        </span>
      </p>
    )
  }
  if (state === 'expired') {
    return (
      <p className="alert alert-warning" role="alert">
        A pré-visualização expirou antes de terminar. Tente de novo.
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
            ? NO_PROVIDER
            : failure.message
          : state === 'failed'
            ? errorMessage(error)
            : 'A pré-visualização não trouxe resultado. Tente de novo.'}
      </p>
    )
  }

  return (
    <section className={styles.previewResult} aria-label="Pré-visualização">
      <div className={styles.previewBlock}>
        <span className="kicker">Detecção · {item.recording_title}</span>
        {item.detected ? (
          <span className="badge badge-success">
            {item.fallback ? 'Nenhum outro tipo se encaixaria: ficaria este' : 'Este tipo seria escolhido'}
            {percent(item.confidence)}
          </span>
        ) : (
          <span className="badge badge-warning">
            {item.fallback ? 'Nenhum tipo se encaixaria: ficaria o padrão,' : 'O agente escolheria'}&nbsp;
            <strong>{item.detected_type_name}</strong>
            {percent(item.confidence)}
          </span>
        )}
      </div>
      <div className={styles.previewBlock}>
        <span className="kicker">Título</span>
        <span>{item.title}</span>
      </div>
      <div className={styles.previewBlock}>
        <span className="kicker">Tags</span>
        {item.tags.length ? (
          <ul className={styles.tags} aria-label="Tags da pré-visualização">
            {item.tags.map((tag) => (
              <li key={tag} className="tag tag-neutral">
                {tag}
              </li>
            ))}
          </ul>
        ) : (
          <span className="text-muted">Nenhuma</span>
        )}
      </div>
      <div className={styles.previewBlock}>
        <span className="kicker">Resumo</span>
        <div className="doc">
          <Markdown components={SAFE_MARKDOWN}>{item.summary_md}</Markdown>
        </div>
      </div>
    </section>
  )
}
