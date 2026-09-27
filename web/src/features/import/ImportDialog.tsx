import { Upload, X } from 'lucide-react'
import { useId, useState, type DragEvent } from 'react'
import { Link } from 'react-router'
import { Dialog } from '../../app/Dialog'
import { checkEnvironment } from '../../lib/media-convert'
import { formatBytes } from '../library/format'
import styles from './ImportDialog.module.css'
import { useImportContext } from './importContext'
import type { ImportDate, ImportItem } from './useImportQueue'

const SOURCE_LABELS: Record<ImportDate['source'], string> = {
  metadata: 'Dos metadados do arquivo',
  file_date: 'Sem data no arquivo · usando a data de modificação, confira',
  user: 'Editada por você',
}

/** "47:12", "1:05:09". */
function clockDuration(seconds: number | null | undefined): string {
  if (seconds == null) return '—'
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

function Status({ item, onRetry }: { item: ImportItem; onRetry: () => void }) {
  const { state } = item
  switch (state.kind) {
    case 'reading':
      return <>Lendo…</>
    case 'ready':
      return <>Pronto para enviar</>
    case 'converting':
      return <>Convertendo {Math.round(state.ratio * 100)}%</>
    case 'uploading':
      return state.progress && state.progress.partsTotal > 0 ? (
        <>
          Enviando {Math.min(state.progress.partsDone + 1, state.progress.partsTotal)} de {state.progress.partsTotal}
        </>
      ) : (
        <>Enviando…</>
      )
    case 'done':
      return (
        <>
          {state.deduplicated ? 'Já estava na biblioteca' : 'Enviado'} ·{' '}
          <Link to={`/gravacoes/${state.recordingId}`}>Abrir</Link>
        </>
      )
    case 'error':
      return (
        <span className={styles.error} title={state.message}>
          Falhou ·{' '}
          <button type="button" className={styles.linkButton} onClick={onRetry}>
            Tentar de novo
          </button>
          <span className="visually-hidden">: {state.message}</span>
        </span>
      )
    case 'canceled':
      return <>Cancelado</>
  }
}

function Row({ item }: { item: ImportItem }) {
  const queue = useImportContext()
  const sourceId = useId()
  const busy = item.state.kind === 'converting' || item.state.kind === 'uploading'
  const editable = item.state.kind === 'reading' || item.state.kind === 'ready' || item.state.kind === 'error'
  const warn = item.date.source === 'file_date'
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
          aria-label={`Início da gravação de ${item.file.name}`}
          aria-describedby={sourceId}
          aria-invalid={!item.date.value || undefined}
          data-warning={warn || undefined}
          onChange={(event) => queue.setDate(item.id, event.target.value)}
        />
        <div className="date-source" id={sourceId} data-warning={warn || undefined}>
          {item.state.kind === 'reading' ? 'Lendo a data do arquivo…' : SOURCE_LABELS[item.date.source]}
        </div>
      </td>
      <td className="tabular">{clockDuration(item.probe?.durationSec)}</td>
      <td aria-live="polite">
        <Status item={item} onRetry={() => queue.retry(item.id)} />
      </td>
      <td>
        {(busy || editable || item.state.kind === 'canceled') && (
          <button
            type="button"
            className={`btn btn-ghost btn-icon ${styles.remove}`}
            aria-label={busy ? `Cancelar o envio de ${item.file.name}` : `Remover ${item.file.name}`}
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
 * O modal Importar sobre a biblioteca (frame "Import files"): zona de soltar e a tabela com o início
 * da gravação de cada arquivo, confirmado antes do envio. Fechar durante o envio só esconde o modal.
 */
export function ImportDialog({ onClose }: { onClose: () => void }) {
  const queue = useImportContext()
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

  /** Cancelar descarta o que não foi enviado; depois do envio, Fechar só esconde o modal. */
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
      title="Importar arquivos"
      kicker="Biblioteca"
      size="lg"
      plain
      onClose={close}
      actions={
        <>
          <button type="button" className="btn btn-secondary" onClick={close}>
            {started ? 'Fechar' : 'Cancelar'}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={blocked || ready.length === 0 || reading || missingDate}
            onClick={queue.send}
          >
            {ready.length === 1 ? 'Enviar 1 arquivo' : `Enviar ${ready.length} arquivos`}
          </button>
        </>
      }
    >
      <div className={styles.body}>
        {blocked && (
          <p className="alert alert-error" role="alert">
            A conversão exige uma conexão segura. Abra o eclume pelo endereço <strong>https://</strong> e instale o
            certificado, se o navegador pedir.
          </p>
        )}
        {!blocked && !environment.webCodecs && (
          <p className="alert alert-warning">
            Este navegador não tem WebCodecs. A conversão usa o modo compatível, mais lento; prefira um Chrome, Edge ou
            Firefox atualizado.
          </p>
        )}
        <label
          className="dropzone"
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
          <strong>Solte áudio ou vídeo aqui</strong>
          <span className="text-muted">
            ou <span className={styles.choose}>escolha arquivos</span> · MP3, M4A, WAV, OGG, MP4, MOV, WebM, MKV e outros
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
                  <th scope="col">Arquivo</th>
                  <th scope="col">Início da gravação</th>
                  <th scope="col">Duração</th>
                  <th scope="col">Situação</th>
                  <th scope="col">
                    <span className="visually-hidden">Ações</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {queue.items.map((item) => (
                  <Row key={item.id} item={item} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Dialog>
  )
}
