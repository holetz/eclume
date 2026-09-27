import { useId, useState, type DragEvent } from 'react'
import { Link } from 'react-router'
import { usePageTitle } from '../../app/usePageTitle'
import { checkEnvironment } from '../../lib/media-convert'
import { formatBytes, formatDuration } from '../library/format'
import styles from './ImportPage.module.css'
import { fileStem, useImport, type ImportState } from './useImport'

export function ImportPage() {
  usePageTitle('Importar arquivo')
  const environment = checkEnvironment()
  const { state, select, start, pause, resume, cancel, reset } = useImport()
  const blocked = !environment.secureContext || !environment.subtleCrypto

  return (
    <section className={styles.page} aria-labelledby="importar-titulo">
      <header className={styles.header}>
        <h1 id="importar-titulo">Importar arquivo</h1>
        <p className="text-muted">
          O áudio é convertido aqui no navegador para Opus, cerca de 15 MB por hora, e só então enviado. Um vídeo de
          vários GB vira um arquivo pequeno, e só o som sai do seu computador.
        </p>
      </header>

      {blocked && (
        <p className="alert alert-error" role="alert">
          A conversão exige uma conexão segura. Abra o eclume pelo endereço <strong>https://</strong> e instale o
          certificado da organização, se o navegador pedir.
        </p>
      )}
      {!blocked && !environment.webCodecs && (
        <p className="alert alert-warning">
          Este navegador não tem WebCodecs. A conversão usa o modo compatível, mais lento; prefira um Chrome, Edge ou
          Firefox atualizado.
        </p>
      )}

      {state.step === 'idle' && <DropZone onFile={select} disabled={blocked} />}
      {state.step === 'selected' && (
        <SelectedFile state={state} onStart={(title) => start(state.file, title)} onChange={reset} disabled={blocked} />
      )}
      {(state.step === 'converting' || state.step === 'uploading' || state.step === 'paused') && (
        <Progress state={state} onPause={pause} onResume={resume} onCancel={cancel} />
      )}
      {state.step === 'error' && (
        <div className={`card ${styles.panel}`}>
          <FileSummary file={state.file} />
          <p className="alert alert-error" role="alert">
            {state.message}
          </p>
          <div className={styles.actions}>
            <button type="button" className="btn btn-primary" onClick={resume}>
              {state.resumable ? 'Retomar o envio' : 'Tentar de novo'}
            </button>
            <button type="button" className="btn btn-secondary" onClick={cancel}>
              Cancelar
            </button>
          </div>
        </div>
      )}
      {state.step === 'done' && (
        <div className={`card ${styles.panel}`}>
          <p className="alert alert-success" role="status">
            {state.deduplicated
              ? 'Este áudio já estava na sua biblioteca: nada foi enviado de novo.'
              : 'Arquivo enviado. A transcrição entrou na fila.'}
          </p>
          <div className={styles.actions}>
            <Link to={`/gravacoes/${state.recordingId}`} className="btn btn-primary">
              {state.deduplicated ? 'Abrir a gravação' : 'Acompanhar a gravação'}
            </Link>
            <button type="button" className="btn btn-secondary" onClick={reset}>
              Importar outro arquivo
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

function DropZone({ onFile, disabled }: { onFile: (file: File) => void; disabled: boolean }) {
  const [dragging, setDragging] = useState(false)
  const inputId = useId()

  function onDrop(event: DragEvent) {
    event.preventDefault()
    setDragging(false)
    const file = event.dataTransfer.files[0]
    if (file && !disabled) onFile(file)
  }

  return (
    <div
      className={styles.dropzone}
      data-dragging={dragging}
      data-disabled={disabled}
      onDragOver={(event) => {
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <p className={styles.dropTitle}>Arraste um arquivo de áudio ou vídeo para cá</p>
      <p className="text-muted">MP3, M4A, WAV, OGG, MP4, MOV, WebM, MKV e outros.</p>
      <label htmlFor={inputId} className="btn btn-primary">
        Escolher arquivo
      </label>
      <input
        id={inputId}
        className="visually-hidden"
        type="file"
        accept="audio/*,video/*"
        disabled={disabled}
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) onFile(file)
        }}
      />
    </div>
  )
}

function FileSummary({ file }: { file: File }) {
  return (
    <div className={styles.file}>
      <span className={styles.fileName}>{file.name}</span>
      <span className="text-muted">{formatBytes(file.size)}</span>
    </div>
  )
}

function SelectedFile({
  state,
  onStart,
  onChange,
  disabled,
}: {
  state: Extract<ImportState, { step: 'selected' }>
  onStart: (title: string) => void
  onChange: () => void
  disabled: boolean
}) {
  const [title, setTitle] = useState(fileStem(state.file.name))
  const titleId = useId()
  const { probe, probing } = state

  return (
    <form
      className={`card ${styles.panel}`}
      onSubmit={(event) => {
        event.preventDefault()
        onStart(title)
      }}
    >
      <FileSummary file={state.file} />
      <p className="text-muted" aria-live="polite">
        {probing
          ? 'Lendo o arquivo…'
          : probe?.durationSec != null
            ? `Duração ${formatDuration(probe.durationSec * 1000)} · deve subir cerca de ${formatBytes(probe.estimatedBytes ?? 0)}`
            : 'Não deu para ler a duração antes de converter; a conversão tenta mesmo assim.'}
      </p>
      {probe?.hasAudio === false && (
        <p className="alert alert-warning">Este arquivo parece não ter áudio. A conversão vai confirmar.</p>
      )}
      <div className="field">
        <label htmlFor={titleId}>Título da gravação</label>
        <input id={titleId} className="input" value={title} onChange={(event) => setTitle(event.target.value)} />
      </div>
      <div className={styles.actions}>
        <button type="submit" className="btn btn-primary" disabled={disabled || probing}>
          Converter e enviar
        </button>
        <button type="button" className="btn btn-secondary" onClick={onChange}>
          Trocar arquivo
        </button>
      </div>
    </form>
  )
}

function Progress({
  state,
  onPause,
  onResume,
  onCancel,
}: {
  state: Extract<ImportState, { step: 'converting' | 'uploading' | 'paused' }>
  onPause: () => void
  onResume: () => void
  onCancel: () => void
}) {
  const converting = state.step === 'converting'
  const progress = state.step === 'converting' ? null : state.progress
  const convertPercent = converting ? Math.round(state.ratio * 100) : 100
  const uploadPercent = progress && progress.bytesTotal > 0 ? Math.round((progress.bytesDone / progress.bytesTotal) * 100) : 0
  const uploadText =
    state.step === 'paused'
      ? 'Envio pausado'
      : !progress || progress.phase === 'creating'
        ? 'Preparando o envio…'
        : progress.phase === 'completing'
          ? 'Concluindo…'
          : `Parte ${progress.partsDone} de ${progress.partsTotal}`

  return (
    <div className={`card ${styles.panel}`}>
      <FileSummary file={state.file} />
      <ol className={styles.steps}>
        <li className={styles.step} data-state={converting ? 'current' : 'done'}>
          <div className={styles.stepHead}>
            <span>1. Converter para Opus</span>
            <span className="tabular">{convertPercent}%</span>
          </div>
          <progress className="progress" max={100} value={convertPercent} aria-label="Conversão" />
        </li>
        <li className={styles.step} data-state={converting ? 'todo' : 'current'}>
          <div className={styles.stepHead}>
            <span>2. Enviar</span>
            {!converting && <span className="tabular">{uploadPercent}%</span>}
          </div>
          {!converting && (
            <>
              <progress className="progress" max={100} value={uploadPercent} aria-label="Envio" />
              <span className={styles.stepDetail}>{uploadText}</span>
            </>
          )}
        </li>
        <li className={styles.step} data-state="todo">
          <div className={styles.stepHead}>
            <span>3. Transcrever no servidor</span>
          </div>
        </li>
      </ol>
      <p className="visually-hidden" aria-live="polite">
        {converting ? `Convertendo: ${convertPercent}%` : uploadText}
      </p>
      <div className={styles.actions}>
        {state.step === 'uploading' && (
          <button type="button" className="btn btn-secondary" onClick={onPause}>
            Pausar
          </button>
        )}
        {state.step === 'paused' && (
          <button type="button" className="btn btn-primary" onClick={onResume}>
            Retomar
          </button>
        )}
        <button type="button" className="btn btn-danger" onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </div>
  )
}
