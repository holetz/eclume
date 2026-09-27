import { Link } from 'react-router'
import type { Schemas } from '../../api/client'
import { errorMessage } from '../../api/problem'
import { usePageTitle } from '../../app/usePageTitle'
import { formatDateTime, stageLabel } from '../library/format'
import styles from './Admin.module.css'
import { HEALTH_REFRESH_MS, useAdminHealth, useRetryJob } from './queries'
import { sectionTitle } from './sections'

type Health = Schemas['AdminHealth']

const MODEL_KINDS: Record<string, string> = {
  asr: 'ASR',
  alignment: 'Alinhamento',
  diarization: 'Diarização',
  embeddings: 'Impressão de voz',
  summarization: 'Sumarização',
}

const QUEUE_LABELS: Record<string, string> = {
  'eclume:gpu': 'Transcrição (GPU)',
  'eclume:default': 'Ingestão e resumos (CPU)',
}

/** Saúde do serviço, relida a cada 10 s. */
export function HealthPage() {
  usePageTitle(sectionTitle('saude'))
  const health = useAdminHealth()
  return (
    <section className={styles.page} aria-labelledby="saude-titulo">
      <div className={styles.intro}>
        <h2 id="saude-titulo">Saúde</h2>
        <p className="muted">
          Filas, worker GPU e jobs da plataforma. Atualiza sozinha a cada {HEALTH_REFRESH_MS / 1000} segundos.
        </p>
        {health.data && <p className={styles.meta}>Verificado às {formatDateTime(health.data.checked_at)}.</p>}
      </div>
      {health.isPending && <p role="status">Consultando a saúde do serviço…</p>}
      {health.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(health.error)}
        </p>
      )}
      {health.data && <HealthView health={health.data} />}
    </section>
  )
}

function HealthView({ health }: { health: Health }) {
  const worker = health.worker
  const gpu = health.gpu
  const queues = health.queues ?? [{ name: 'eclume:gpu', queued: health.queue.queued, running: health.queue.running }]
  const jobs = health.running_jobs ?? []
  return (
    <>
      <div className={styles.cards}>
        <article className={`card ${styles.card}`} aria-labelledby="saude-worker">
          <h3 id="saude-worker">Worker GPU</h3>
          {worker === undefined ? (
            <p className="muted">O servidor não informa o estado do worker.</p>
          ) : worker === null ? (
            <p>
              <span className="badge badge-danger">Sem sinal</span>{' '}
              <span className="muted">Nenhum heartbeat nos últimos 45 segundos: o worker pode estar parado.</span>
            </p>
          ) : (
            <dl className={styles.facts}>
              <dt>Estado</dt>
              <dd>
                <span className="badge badge-success">No ar</span>{' '}
                {worker.busy ? <span className="badge badge-progress">Transcrevendo</span> : <span className="badge badge-neutral">Ocioso</span>}
              </dd>
              <dt>Último sinal</dt>
              <dd>{formatDateTime(worker.last_seen_at)}</dd>
              <dt>Motor</dt>
              <dd>{worker.engine ?? '—'}</dd>
              <dt>Dispositivo</dt>
              <dd>{worker.device ?? '—'}</dd>
              <dt>Versão</dt>
              <dd>{worker.version ?? '—'}</dd>
            </dl>
          )}
        </article>

        <article className={`card ${styles.card}`} aria-labelledby="saude-gpu">
          <h3 id="saude-gpu">GPU</h3>
          {gpu ? (
            <>
              <p>{gpu.name}</p>
              <label className={styles.meta} htmlFor="saude-vram">
                VRAM: {gpu.vram_used_mb.toLocaleString('pt-BR')} de {gpu.vram_total_mb.toLocaleString('pt-BR')} MiB
              </label>
              <meter
                id="saude-vram"
                className={styles.meter}
                min={0}
                max={gpu.vram_total_mb || 1}
                high={(gpu.vram_total_mb || 1) * 0.85}
                value={gpu.vram_used_mb}
              />
              <p className={styles.meta}>Utilização: {Math.round(gpu.utilization_pct)}%</p>
            </>
          ) : (
            <p className="muted">Sem leitura da GPU (worker parado ou rodando em CPU).</p>
          )}
          <h4>Modelos carregados</h4>
          {health.models_loaded.length === 0 ? (
            <p className="muted">Nenhum: os modelos saem da GPU depois de alguns minutos sem job.</p>
          ) : (
            <ul className={styles.list}>
              {health.models_loaded.map((model) => (
                <li key={`${model.kind}-${model.name}`}>
                  <span className={styles.strong}>{MODEL_KINDS[model.kind] ?? model.kind}</span>
                  <span className={styles.mono}>{model.name}</span>
                  <span className={styles.meta}>
                    {' '}
                    desde {formatDateTime(model.loaded_at)}
                    {model.vram_mb != null && ` · ${model.vram_mb.toLocaleString('pt-BR')} MiB`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </article>
      </div>

      <section className={styles.section} aria-labelledby="saude-filas">
        <h3 id="saude-filas">Filas</h3>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Fila</th>
                <th scope="col">Na fila</th>
                <th scope="col">Rodando</th>
              </tr>
            </thead>
            <tbody>
              {queues.map((queue) => (
                <tr key={queue.name}>
                  <th scope="row">
                    <span className={styles.strong}>{QUEUE_LABELS[queue.name] ?? queue.name}</span>
                    <span className={styles.mono}>{queue.name}</span>
                  </th>
                  <td className="tabular">{queue.queued}</td>
                  <td className="tabular">{queue.running}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className={styles.section} aria-labelledby="saude-jobs">
        <h3 id="saude-jobs">Transcrições em andamento</h3>
        {jobs.length === 0 ? (
          <p className="muted">Nenhuma transcrição na fila ou rodando.</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Gravação</th>
                  <th scope="col">Etapa</th>
                  <th scope="col">Progresso</th>
                  <th scope="col">Último avanço</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.job_id}>
                    <th scope="row">{job.recording_title}</th>
                    <td>{job.state === 'queued' ? 'Na fila' : (stageLabel(job.stage ?? '') ?? 'Rodando')}</td>
                    <td className="tabular">{job.progress == null ? '—' : `${Math.round(job.progress * 100)}%`}</td>
                    <td>{job.updated_at ? formatDateTime(job.updated_at) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className={styles.section} aria-labelledby="saude-falhas">
        <h3 id="saude-falhas">Falhas nas últimas 24 horas: {health.queue.failed_last_24h}</h3>
        {health.recent_failures.length > 0 && (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Quando</th>
                  <th scope="col">Código</th>
                  <th scope="col">Mensagem</th>
                  <th scope="col">
                    <span className="visually-hidden">Gravação</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {health.recent_failures.map((failure) => (
                  <tr key={failure.job_id}>
                    <td>{formatDateTime(failure.failed_at)}</td>
                    <td className={styles.mono}>{failure.code}</td>
                    <td>{failure.message}</td>
                    <td className={styles.actionsCell}>
                      <RetryJobButton jobId={failure.job_id} retryable={failure.retryable === true} />{' '}
                      <Link to={`/gravacoes/${failure.recording_id}`}>Abrir gravação</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  )
}

/** Retentar um job da lista de falhas; a falha passageira vem destacada. */
function RetryJobButton({ jobId, retryable }: { jobId: string; retryable: boolean }) {
  const retry = useRetryJob()
  if (retry.isSuccess) return <span className="muted">Na fila de novo.</span>
  return (
    <>
      <button
        type="button"
        className={retryable ? 'btn btn-primary' : 'btn'}
        disabled={retry.isPending}
        title={retryable ? 'Falha passageira: tentar de novo costuma resolver.' : undefined}
        onClick={() => retry.mutate(jobId)}
      >
        {retry.isPending ? 'Enfileirando…' : 'Tentar de novo'}
      </button>
      {retry.isError && (
        <span className="alert alert-error" role="alert">
          {errorMessage(retry.error)}
        </span>
      )}
    </>
  )
}
