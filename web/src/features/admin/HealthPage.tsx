import type { Schemas } from '../../api/client'
import { errorMessage } from '../../api/problem'

import { AdminPageHead } from './AdminPageHead'
import styles from './Admin.module.css'
import { formatDuration, labelOf, SERVICE_STATUS, SERVICES, STEP_ORDER, STEPS } from './labels'
import { HEALTH_MAX_REFRESH_MS, HEALTH_REFRESH_MS, useAdminHealth, useRetryJob } from './queries'
import { formatDateTime } from '../../shared/format'

type Health = Schemas['AdminHealth']
type Failure = Health['recent_failures'][number]

const clock = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const gigabytes = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 })
const gb = (mb: number) => gigabytes.format(mb / 1024)

/**
 * Saúde da plataforma, relida a cada 15 s só com a aba visível. Sem conteúdo de usuário: nem
 * título nem arquivo de gravação aparecem aqui.
 */
export function HealthPage() {
  const health = useAdminHealth()
  const data = health.data
  return (
    <>
      <AdminPageHead
        title="Saúde"
        actions={
          data && (
            <span className={`text-muted tabular ${styles.note}`} aria-live="polite">
              Atualizado às {clock.format(new Date(data.checked_at))} · a cada {HEALTH_REFRESH_MS / 1000} a {HEALTH_MAX_REFRESH_MS / 1000} s
            </span>
          )
        }
      />
      {health.isPending && <p role="status">Consultando a saúde do serviço…</p>}
      {/* Um erro de leitura mantém os últimos dados na tela. */}
      {health.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(health.error)}
        </p>
      )}
      {data && <HealthView health={data} />}
    </>
  )
}

function HealthView({ health }: { health: Health }) {
  const { worker, gpu, queue } = health
  const asr = health.models_loaded.find((model) => model.kind === 'asr')
  const steps = STEP_ORDER.map(
    (step) => health.steps.find((item) => item.step === step) ?? { step, runs: 0, median_ms: null, failures: 0 },
  )
  const failures = steps.reduce((total, step) => total + step.failures, 0)
  const latest = health.recent_failures[0]

  return (
    <>
      <div className={`stats ${styles.healthStats}`}>
        <Stat
          kicker="Worker GPU"
          value={worker ? (worker.busy ? 'Transcrevendo' : 'Ocioso') : 'Sem sinal'}
          danger={!worker}
          sub={gpu ? `${gpu.name} · ${gb(gpu.vram_total_mb)} GB` : 'Sem leitura da GPU'}
        />
        <Stat
          kicker="Modelo residente"
          value={asr?.name ?? 'Nenhum'}
          sub={
            asr && gpu
              ? `${gb(gpu.vram_used_mb)} / ${gb(gpu.vram_total_mb)} GB de VRAM`
              : 'Sai da GPU depois de alguns minutos sem job'
          }
        />
        <Stat
          kicker="Fila"
          value={String(queue.queued + queue.running)}
          sub={`${queue.running} rodando · ${queue.queued} esperando`}
        />
        <Stat
          kicker="Falhas · 24 h"
          value={String(failures)}
          sub={latest ? `${labelOf(STEPS, latest.step)} · ${latest.code}` : 'Nenhuma falha'}
        />
      </div>

      <section aria-labelledby="saude-etapas">
        <h4 id="saude-etapas" className={styles.healthTitle}>
          Etapas do processamento · últimas 24 h
        </h4>
        <div className={styles.scroll}>
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Etapa</th>
                <th scope="col">Execuções</th>
                <th scope="col">Mediana</th>
                <th scope="col">Falhas</th>
              </tr>
            </thead>
            <tbody>
              {steps.map((step) => (
                <tr key={step.step}>
                  <th scope="row" className={styles.rowHead}>
                    <strong>{labelOf(STEPS, step.step)}</strong>
                  </th>
                  <td className="tabular">{step.runs}</td>
                  <td className="tabular mono">{step.median_ms == null ? '—' : formatDuration(step.median_ms)}</td>
                  <td>
                    {step.failures === 0 ? (
                      <span className="text-muted">0</span>
                    ) : (
                      <span className="badge badge-danger">
                        {step.failures} {step.failures === 1 ? 'falha' : 'falhas'}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="saude-servicos">
        <h4 id="saude-servicos" className={styles.healthTitle}>
          Serviços
        </h4>
        <div className={styles.scroll}>
          <table className="table" aria-labelledby="saude-servicos">
            <tbody>
              {health.services.map((service) => {
                const status = SERVICE_STATUS[service.status] ?? { label: service.status, badge: 'badge' }
                const detail = [service.detail, service.latency_ms != null && `${service.latency_ms} ms`]
                  .filter(Boolean)
                  .join(' · ')
                return (
                  <tr key={service.name}>
                    <th scope="row" className={styles.rowHead}>
                      <strong>{labelOf(SERVICES, service.name)}</strong>
                    </th>
                    <td>
                      <span className={status.badge}>{status.label}</span>
                    </td>
                    <td className="text-muted">{detail}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      {health.recent_failures.length > 0 && (
        <section aria-labelledby="saude-falhas">
          <h4 id="saude-falhas" className={styles.healthTitle}>
            Falhas recentes
          </h4>
          <div className={styles.scroll}>
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Quando</th>
                  <th scope="col">Etapa</th>
                  <th scope="col">Código</th>
                  <th scope="col">Mensagem</th>
                  <th scope="col">
                    <span className="visually-hidden">Ações</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {health.recent_failures.map((failure) => (
                  <FailureRow key={`${failure.recording_id}-${failure.step ?? ''}-${failure.failed_at}`} failure={failure} />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  )
}

function Stat({ kicker, value, sub, danger }: { kicker: string; value: string; sub: string; danger?: boolean }) {
  return (
    <div className="stat">
      <span className="kicker">{kicker}</span>
      <span className={danger ? `stat-value ${styles.danger}` : 'stat-value'}>{value}</span>
      <span className="stat-sub">{sub}</span>
    </div>
  )
}

/** Uma falha, sem link para a gravação: a sessão de admin não abre /gravacoes. */
function FailureRow({ failure }: { failure: Failure }) {
  const retry = useRetryJob()
  return (
    <tr>
      <td className="tabular">{formatDateTime(failure.failed_at)}</td>
      <td>{labelOf(STEPS, failure.step)}</td>
      <td className="mono">{failure.code}</td>
      <td>{failure.message}</td>
      <td className={styles.actionsCell}>
        {/* Só a transcrição tem job para retentar (holetz/eclume#33). */}
        {failure.job_id &&
          (retry.isSuccess ? (
            <span className="text-muted">Na fila de novo.</span>
          ) : (
            <button
              type="button"
              className={failure.retryable ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
              disabled={retry.isPending}
              title={failure.retryable ? 'Falha passageira: tentar de novo costuma resolver.' : undefined}
              onClick={() => retry.mutate(failure.job_id!)}
            >
              {retry.isPending ? 'Enfileirando…' : 'Tentar de novo'}
            </button>
          ))}
        {retry.isError && (
          <span className={styles.error} role="alert">
            {errorMessage(retry.error)}
          </span>
        )}
      </td>
    </tr>
  )
}
