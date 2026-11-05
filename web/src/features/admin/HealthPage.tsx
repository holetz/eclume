import { useTranslation } from 'react-i18next'
import type { Schemas } from '../../api/client'
import { errorMessage } from '../../api/problem'

import { AdminPageHead } from './AdminPageHead'
import styles from './Admin.module.css'
import { dateFormat, formatDuration, labelOf, numberFormat, SERVICE_STATUS, SERVICES, STEP_ORDER, STEPS } from './labels'
import { HEALTH_MAX_REFRESH_MS, HEALTH_REFRESH_MS, useAdminHealth, useRetryJob } from './queries'
import { formatDateTime } from '../../shared/format'

type Health = Schemas['AdminHealth']
type Failure = Health['recent_failures'][number]

const clock = (iso: string) => dateFormat('clock', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(iso))
const gb = (mb: number) => numberFormat('gigabytes', { maximumFractionDigits: 1 }).format(mb / 1024)

/**
 * Platform health, reread every 15 s only with the tab visible. No user content: neither
 * a recording's title nor its file shows here.
 */
export function HealthPage() {
  const { t } = useTranslation('admin')
  const health = useAdminHealth()
  const data = health.data
  return (
    <>
      <AdminPageHead
        title={t('health.title')}
        actions={
          data && (
            <span className={`text-muted tabular ${styles.note}`} aria-live="polite">
              {t('health.updated', { time: clock(data.checked_at), min: HEALTH_REFRESH_MS / 1000, max: HEALTH_MAX_REFRESH_MS / 1000 })}
            </span>
          )
        }
      />
      {health.isPending && <p role="status">{t('health.loading')}</p>}
      {/* A read error keeps the last data on screen. */}
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
  const { t } = useTranslation('admin')
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
          kicker={t('health.gpuWorker')}
          value={worker ? (worker.busy ? t('health.transcribing') : t('health.idle')) : t('health.noSignal')}
          danger={!worker}
          sub={gpu ? t('health.gpu', { name: gpu.name, total: gb(gpu.vram_total_mb) }) : t('health.noGpu')}
        />
        <Stat
          kicker={t('health.model')}
          value={asr?.name ?? t('health.noModel')}
          sub={
            asr && gpu
              ? t('health.vram', { used: gb(gpu.vram_used_mb), total: gb(gpu.vram_total_mb) })
              : t('health.modelHint')
          }
        />
        <Stat
          kicker={t('health.queue')}
          value={String(queue.queued + queue.running)}
          sub={t('health.queueSub', { running: queue.running, queued: queue.queued })}
        />
        <Stat
          kicker={t('health.failures24')}
          value={String(failures)}
          sub={latest ? `${labelOf(STEPS, latest.step)} · ${latest.code}` : t('health.noFailures')}
        />
      </div>

      <section aria-labelledby="saude-etapas">
        <h4 id="saude-etapas" className={styles.healthTitle}>
          {t('health.steps')}
        </h4>
        <div className={styles.scroll}>
          <table className="table">
            <thead>
              <tr>
                <th scope="col">{t('health.step')}</th>
                <th scope="col">{t('health.runs')}</th>
                <th scope="col">{t('health.median')}</th>
                <th scope="col">{t('health.failures')}</th>
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
                        {t('health.failureCount', { count: step.failures })}
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
          {t('health.services')}
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
            {t('health.recent')}
          </h4>
          <div className={styles.scroll}>
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">{t('health.when')}</th>
                  <th scope="col">{t('health.step')}</th>
                  <th scope="col">{t('health.code')}</th>
                  <th scope="col">{t('health.message')}</th>
                  <th scope="col">
                    <span className="visually-hidden">{t('health.actions')}</span>
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

/** A failure, without a link to the recording: the admin session does not open /gravacoes. */
function FailureRow({ failure }: { failure: Failure }) {
  const { t } = useTranslation('admin')
  const retry = useRetryJob()
  return (
    <tr>
      <td className="tabular">{formatDateTime(failure.failed_at)}</td>
      <td>{labelOf(STEPS, failure.step)}</td>
      <td className="mono">{failure.code}</td>
      <td>{failure.message}</td>
      <td className={styles.actionsCell}>
        {/* Only transcription has a job to retry (holetz/eclume#33). */}
        {failure.job_id &&
          (retry.isSuccess ? (
            <span className="text-muted">{t('health.queued')}</span>
          ) : (
            <button
              type="button"
              className={failure.retryable ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
              disabled={retry.isPending}
              title={failure.retryable ? t('health.transient') : undefined}
              onClick={() => retry.mutate(failure.job_id!)}
            >
              {retry.isPending ? t('health.queueing') : t('health.retry')}
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
