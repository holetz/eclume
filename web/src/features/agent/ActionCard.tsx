import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { errorMessage } from '../../api/problem'
import { isRunning, useAgentAction, useDecideAction, type AgentAction } from './agent'
import styles from './AgentPage.module.css'
import { i18n } from '../../i18n'

const SHOWN = 10

const statusLabel = (status: AgentAction['status']) => i18n.t(`agent:action.status.${status}`)

const resultLabel = (status: 'done' | 'skipped' | 'failed') => i18n.t(`agent:action.result.${status}`)

function countsNote(action: AgentAction): string {
  const { done, skipped, failed, pending } = action.counts
  const parts: string[] = [i18n.t('agent:action.counts.done', { n: done })]
  if (skipped) parts.push(i18n.t('agent:action.counts.skipped', { n: skipped }))
  if (failed) parts.push(i18n.t('agent:action.counts.failed', { n: failed }))
  if (pending) parts.push(i18n.t('agent:action.counts.pending', { n: pending }))
  return parts.join(', ')
}

/**
 * The confirmation card of an action the Agent proposes: what will be done and to which recordings.
 * Nothing changes before Confirmar; afterwards, the card follows the run and shows each target's result.
 */
export function ActionCard({ action }: { action: AgentAction }) {
  const { t } = useTranslation('agent')
  const query = useAgentAction(action)
  const decide = useDecideAction()
  const current = query.data ?? action
  const targets = current.targets
  const finished = current.status === 'done' || current.status === 'failed'

  return (
    <section className={`card ${styles.action}`} aria-label={t('action.label')}>
      <p className={styles.actionSummary}>{current.summary}</p>
      <p className="text-muted" role="status">
        {statusLabel(current.status)}
        {finished && ` · ${countsNote(current)}`}
      </p>
      <ul className={styles.actionTargets} aria-label={t('action.targets')}>
        {targets.slice(0, SHOWN).map((target) => (
          <li key={target.recording_id}>
            <Link to={`/gravacoes/${target.recording_id}`}>{target.title}</Link>
            {target.result && (
              <span className={target.result.status === 'failed' ? styles.warn : 'text-muted'}>
                {' '}
                · {resultLabel(target.result.status)}
                {target.result.status !== 'done' && target.result.detail ? `: ${target.result.detail}` : ''}
              </span>
            )}
          </li>
        ))}
        {targets.length > SHOWN && <li className="text-muted">{t('action.more', { n: targets.length - SHOWN })}</li>}
      </ul>
      {current.status === 'proposed' && (
        <div className={styles.actionButtons}>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={decide.isPending}
            onClick={() => decide.mutate({ id: current.id, decision: 'confirm' })}
          >
            {t('action.confirm')}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={decide.isPending}
            onClick={() => decide.mutate({ id: current.id, decision: 'cancel' })}
          >
            {t('action.discard')}
          </button>
        </div>
      )}
      {isRunning(current) && <span className={styles.working}>{t('action.running')}</span>}
      {(decide.isError || query.isError) && (
        <p className="alert alert-error" role="alert">
          {errorMessage(decide.error ?? query.error)}
        </p>
      )}
    </section>
  )
}
