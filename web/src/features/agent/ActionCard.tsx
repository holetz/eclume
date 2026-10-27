import { Link } from 'react-router'
import { errorMessage } from '../../api/problem'
import { isRunning, useAgentAction, useDecideAction, type AgentAction } from './agent'
import styles from './AgentPage.module.css'

const SHOWN = 10

const STATUS: Record<AgentAction['status'], string> = {
  proposed: 'Aguardando a sua confirmação',
  queued: 'Na fila',
  running: 'Executando',
  done: 'Concluída',
  failed: 'Falhou',
  cancelled: 'Descartada',
  expired: 'Venceu sem confirmação',
}

const RESULT: Record<'done' | 'skipped' | 'failed', string> = {
  done: 'feito',
  skipped: 'sem mudança',
  failed: 'falhou',
}

function countsNote(action: AgentAction): string {
  const { done, skipped, failed, pending } = action.counts
  const parts = [`${done} feita(s)`]
  if (skipped) parts.push(`${skipped} sem mudança`)
  if (failed) parts.push(`${failed} com falha`)
  if (pending) parts.push(`${pending} pendente(s)`)
  return parts.join(', ')
}

/**
 * The confirmation card of an action the Agent proposes: what will be done and to which recordings.
 * Nothing changes before Confirmar; afterwards, the card follows the run and shows each target's result.
 */
export function ActionCard({ action }: { action: AgentAction }) {
  const query = useAgentAction(action)
  const decide = useDecideAction()
  const current = query.data ?? action
  const targets = current.targets
  const finished = current.status === 'done' || current.status === 'failed'

  return (
    <section className={`card ${styles.action}`} aria-label="Ação proposta">
      <p className={styles.actionSummary}>{current.summary}</p>
      <p className="text-muted" role="status">
        {STATUS[current.status]}
        {finished && ` · ${countsNote(current)}`}
      </p>
      <ul className={styles.actionTargets} aria-label="Gravações afetadas">
        {targets.slice(0, SHOWN).map((target) => (
          <li key={target.recording_id}>
            <Link to={`/gravacoes/${target.recording_id}`}>{target.title}</Link>
            {target.result && (
              <span className={target.result.status === 'failed' ? styles.warn : 'text-muted'}>
                {' '}
                · {RESULT[target.result.status]}
                {target.result.status !== 'done' && target.result.detail ? `: ${target.result.detail}` : ''}
              </span>
            )}
          </li>
        ))}
        {targets.length > SHOWN && <li className="text-muted">e mais {targets.length - SHOWN}</li>}
      </ul>
      {current.status === 'proposed' && (
        <div className={styles.actionButtons}>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={decide.isPending}
            onClick={() => decide.mutate({ id: current.id, decision: 'confirm' })}
          >
            Confirmar
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={decide.isPending}
            onClick={() => decide.mutate({ id: current.id, decision: 'cancel' })}
          >
            Descartar
          </button>
        </div>
      )}
      {isRunning(current) && <span className={styles.working}>Executando a ação</span>}
      {(decide.isError || query.isError) && (
        <p className="alert alert-error" role="alert">
          {errorMessage(decide.error ?? query.error)}
        </p>
      )}
    </section>
  )
}
