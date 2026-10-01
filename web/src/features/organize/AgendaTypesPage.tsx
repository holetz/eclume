import { useEffect } from 'react'
import { useLocation } from 'react-router'
import { errorMessage } from '../../api/problem'
import { useHelpTopic } from '../../app/help'
import { markAgendaTypesSeen } from '../../app/preferences'
import { PageHead } from '../../app/PageHead'
import type { InstructionsRequestState } from '../transcript/ChatPanel'
import { AgendaTypeEditor } from './AgendaTypeEditor'
import styles from './Organize.module.css'
import { useAgendaTypes, type AgendaType } from './queries'
import { NEW, useGuardedSelection } from './useGuardedSelection'

const SUMMARY_LINE_MAX = 60

/** "Resumo: " com os títulos `##` das instruções, em minúsculas; sem títulos, a primeira linha, cortada numa palavra. */
function summaryLabel(instructions: string): string {
  const headings = [...instructions.matchAll(/^##\s+(.+?)\s*$/gm)].map((match) => match[1].toLowerCase())
  if (headings.length) return `Resumo: ${headings.join(', ')}`
  const first = instructions.split('\n').find((line) => line.trim())?.trim() ?? ''
  if (first.length <= SUMMARY_LINE_MAX) return `Resumo: ${first}`
  // Corta na última palavra inteira, sem a pontuação solta do fim.
  const cut = first
    .slice(0, SUMMARY_LINE_MAX + 1)
    .replace(/\s+\S*$/, '')
    .replace(/[\s,;:.]+$/, '')
  return `Resumo: ${cut}…`
}

export function AgendaTypesPage() {
  useHelpTopic('agendas')
  useEffect(markAgendaTypesSeen, [])
  const types = useAgendaTypes()
  // O tipo padrão fica no topo, com o selo; os outros na ordem do usuário.
  const items = [...(types.data?.items ?? [])].sort(
    (a, b) => Number(b.fallback) - Number(a.fallback) || a.position - b.position,
  )
  const { selected, select, apply, setDirty, discardDialog } = useGuardedSelection('tipo')
  // O pedido que o chat do resumo mandou para este tipo, no `state` da navegação.
  const location = useLocation()
  const instructionsRequest = (location.state as Partial<InstructionsRequestState> | null)?.instructionsRequest
  const current = selected === NEW ? null : (items.find((t) => t.id === selected) ?? (selected ? undefined : items[0]))

  return (
    <section className={styles.page}>
      <PageHead
        kicker="Organizar"
        title="Tipos de agenda"
        actions={
          <button type="button" className="btn btn-primary" onClick={() => select(NEW)}>
            Novo tipo
          </button>
        }
      />
      <p className="text-muted">
        Depois da transcrição, o eclume escolhe um destes tipos para a gravação, dá o título pelo padrão
        dele e faz o resumo pelas instruções dele. Quando nenhum se encaixa com confiança, fica o tipo
        padrão.
      </p>

      {types.isPending && <p role="status">Carregando tipos de agenda…</p>}
      {types.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(types.error)}
        </p>
      )}
      {types.isSuccess && (
        <div className={`split ${styles.split}`}>
          <ul className={`list ${styles.list}`} aria-label="Tipos de agenda">
            {items.map((type) => (
              <AgendaTypeRow
                key={type.id}
                type={type}
                selected={type.id === current?.id}
                onSelect={() => select(type.id)}
              />
            ))}
          </ul>
          {current === undefined ? (
            !types.isFetching && <p className="text-muted">Este tipo não existe mais. Escolha outro na lista.</p>
          ) : (
            <AgendaTypeEditor
              key={current?.id ?? NEW}
              type={current}
              onDirtyChange={setDirty}
              onSaved={(saved) => apply(saved.id)}
              onDeleted={() => apply(null)}
              summaryAddition={current && current.id === selected ? instructionsRequest : undefined}
            />
          )}
        </div>
      )}
      {discardDialog}
    </section>
  )
}

function AgendaTypeRow({ type, selected, onSelect }: { type: AgendaType; selected: boolean; onSelect: () => void }) {
  return (
    <li className={selected ? `list-row ${styles.selected}` : 'list-row'}>
      <button
        type="button"
        className={`list-row-title ${styles.rowButton}`}
        aria-current={selected || undefined}
        onClick={onSelect}
      >
        {type.name}
        {type.fallback && <span className={`badge ${styles.badge}`}>Padrão</span>}
      </button>
      <span className="list-row-sub">{summaryLabel(type.summary_instructions)}</span>
    </li>
  )
}
