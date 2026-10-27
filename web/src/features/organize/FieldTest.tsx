import type { Schemas } from '../../api/client'
import { errorMessage } from '../../api/problem'
import styles from './Organize.module.css'
import { fieldTestRows, type PreviewRun } from './usePreview'

const NO_PROVIDER = 'Nenhum agente está configurado para preencher campos. Peça a quem administra o servidor.'

/** The result of "Testar numa gravação": the draft rule on the latest transcribed recordings. */
export function FieldTest({ test }: { test: PreviewRun<Schemas['FieldPreviewRequest']> }) {
  const { state, preview, elapsedMs, error } = test
  if (state === 'idle') return null

  if (state === 'queued' || state === 'running') {
    return (
      <p className="alert" role="status">
        <span>
          Testando a regra nas últimas 3 gravações…{' '}
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
        O teste expirou antes de terminar. Teste de novo.
      </p>
    )
  }

  if (state === 'failed') {
    const failure = preview?.error
    return (
      <p className="alert alert-error" role="alert">
        {failure ? (failure.code === 'no_provider' ? NO_PROVIDER : failure.message) : errorMessage(error)}
      </p>
    )
  }

  const rows = preview ? fieldTestRows(preview) : []
  if (rows.length === 0) {
    return (
      <p className="alert" role="status">
        Você ainda não tem gravações transcritas para testar.
      </p>
    )
  }
  return (
    <div className="alert" role="status">
      <span className="alert-title">
        {rows.length === 1 ? 'Na última gravação' : `Nas últimas ${rows.length} gravações`}
      </span>
      <ul className={styles.testRows} aria-label="Resultado do teste">
        {rows.map((row) => (
          <li key={row.recordingId}>
            {row.recordingTitle} → {row.value === null ? <em>vazio</em> : <strong>{row.value}</strong>}
          </li>
        ))}
      </ul>
    </div>
  )
}
