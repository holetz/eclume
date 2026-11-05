import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'react-router'
import { errorMessage } from '../../api/problem'
import { i18n } from '../../i18n'
import { useHelpTopic } from '../../app/help'
import { markAgendaTypesSeen } from '../../app/preferences'
import { PageHead } from '../../app/PageHead'
import { AgendaTypeEditor } from './AgendaTypeEditor'
import styles from './Organize.module.css'
import { useAgendaTypes, type AgendaType, type InstructionsRequestState } from './queries'
import { NEW, useGuardedSelection } from './useGuardedSelection'

const SUMMARY_LINE_MAX = 60

/** "Resumo: " with the `##` headings of the instructions, in lowercase; with no headings, the first line, cut at a word. */
function summaryLabel(instructions: string): string {
  const headings = [...instructions.matchAll(/^##\s+(.+?)\s*$/gm)].map((match) => match[1].toLowerCase())
  if (headings.length) return i18n.t('organize:types.summaryLine', { text: headings.join(', ') })
  const first = instructions.split('\n').find((line) => line.trim())?.trim() ?? ''
  if (first.length <= SUMMARY_LINE_MAX) return i18n.t('organize:types.summaryLine', { text: first })
  // Cuts at the last whole word, without the stray punctuation at the end.
  const cut = first
    .slice(0, SUMMARY_LINE_MAX + 1)
    .replace(/\s+\S*$/, '')
    .replace(/[\s,;:.]+$/, '')
  return i18n.t('organize:types.summaryCut', { text: cut })
}

export function AgendaTypesPage() {
  useHelpTopic('agendas')
  useEffect(markAgendaTypesSeen, [])
  const { t } = useTranslation('organize')
  const types = useAgendaTypes()
  // The fallback agenda type stays on top, with the badge; the others in the user's order.
  const items = [...(types.data?.items ?? [])].sort(
    (a, b) => Number(b.fallback) - Number(a.fallback) || a.position - b.position,
  )
  const { selected, select, apply, setDirty, discardDialog } = useGuardedSelection('tipo')
  // The request the summary chat sent for this agenda type, in the navigation `state`.
  const location = useLocation()
  const instructionsRequest = (location.state as Partial<InstructionsRequestState> | null)?.instructionsRequest
  const current = selected === NEW ? null : (items.find((item) => item.id === selected) ?? (selected ? undefined : items[0]))

  return (
    <section className={styles.page}>
      <PageHead
        kicker={t('types.kicker')}
        title={t('types.title')}
        actions={
          <button type="button" className="btn btn-primary" onClick={() => select(NEW)}>
            {t('types.new')}
          </button>
        }
      />
      <p className="text-muted">
        {t('types.intro')}
      </p>

      {types.isPending && <p role="status">{t('types.loading')}</p>}
      {types.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(types.error)}
        </p>
      )}
      {types.isSuccess && (
        <div className={`split ${styles.split}`}>
          <ul className={`list ${styles.list}`} aria-label={t('types.title')}>
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
            !types.isFetching && <p className="text-muted">{t('types.gone')}</p>
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
  const { t } = useTranslation('organize')
  return (
    <li className={selected ? `list-row ${styles.selected}` : 'list-row'}>
      <button
        type="button"
        className={`list-row-title ${styles.rowButton}`}
        aria-current={selected || undefined}
        onClick={onSelect}
      >
        {type.name}
        {type.fallback && <span className={`badge ${styles.badge}`}>{t('types.default')}</span>}
      </button>
      <span className="list-row-sub">{summaryLabel(type.summary_instructions)}</span>
    </li>
  )
}
