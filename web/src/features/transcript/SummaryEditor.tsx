import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Schemas } from '../../api/client'
import { errorMessage } from '../../api/problem'
import { ConfirmDialog } from '../../app/ConfirmDialog'
import { useLeaveGuard } from '../../app/useLeaveGuard'
import styles from './RecordingPage.module.css'
import { isSummaryChanged, useSummaryMutations, useSummaryState, type SummaryState } from './summary'
import { diffLines } from './summary-diff'
import { readSummaryDraft, writeSummaryDraft } from './summaryDraft'

type Recording = Schemas['Recording']

const DRAFT_WRITE_DELAY_MS = 500

const PREFIX = { same: ' ', removed: '−', added: '+' } as const

/** The lines of two versions side by side in time: removed in `<del>` and added in `<ins>`. */
export function SummaryDiff({ before, after, label }: { before: string; after: string; label: string }) {
  return (
    <div className={`doc ${styles.diff}`} role="region" aria-label={label}>
      {diffLines(before, after).map((line, index) => {
        const content = (
          <>
            <span className={styles.diffSign} aria-hidden="true">
              {PREFIX[line.kind]}
            </span>
            {line.text || ' '}
          </>
        )
        if (line.kind === 'removed') return <del key={index}>{content}</del>
        if (line.kind === 'added') return <ins key={index}>{content}</ins>
        return <span key={index}>{content}</span>
      })}
    </div>
  )
}

interface SummaryEditorProps {
  recording: Recording
  state: SummaryState
  onDone: () => void
}

/**
 * The summary edit (frame "editing the summary"): the Markdown in the document typography, saved as a
 * new version on top of the open version. If another version came in meanwhile (409), the draft stays and
 * the person chooses to see the new one or to save over it.
 */
export function SummaryEditor({ recording, state, onDone }: SummaryEditorProps) {
  const { t } = useTranslation(['transcript', 'common'])
  const { edit, revert } = useSummaryMutations(recording)
  const latest = useSummaryState(recording.id)
  const opened = state.current
  // The stored draft comes back on reopening; if the version moved since then, it comes back with the conflict notice.
  const [saved] = useState(() => readSummaryDraft(recording.id))
  const [draft, setDraft] = useState(saved?.content_md ?? opened?.content_md ?? '')
  const [base, setBase] = useState(saved?.base_version ?? opened?.version ?? 0)
  const [conflict, setConflict] = useState<{ version: number; content: string } | null>(() =>
    saved && opened && saved.base_version < opened.version
      ? { version: opened.version, content: opened.content_md ?? '' }
      : null,
  )
  const [showConflict, setShowConflict] = useState(false)
  const [confirm, setConfirm] = useState<'discard' | 'revert' | null>(null)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const changed = draft !== (opened?.content_md ?? '')
  const leaveDialog = useLeaveGuard(changed, {
    title: t('editor.discardTitle'),
    message: <p>{t('editor.discardText')}</p>,
    onDiscard: () => writeSummaryDraft(recording.id, null),
  })

  // The area grows with the content, like the document.
  useLayoutEffect(() => {
    const text = textRef.current
    if (!text) return
    text.style.height = 'auto'
    text.style.height = `${text.scrollHeight}px`
  }, [draft])

  useEffect(() => {
    if (draft === (opened?.content_md ?? '') && base === (opened?.version ?? 0)) {
      writeSummaryDraft(recording.id, null)
      return
    }
    const timer = window.setTimeout(
      () => writeSummaryDraft(recording.id, { base_version: base, content_md: draft }),
      DRAFT_WRITE_DELAY_MS,
    )
    return () => window.clearTimeout(timer)
  }, [recording.id, draft, base, opened])

  // Saving, discarding or reverting to the generated one ends the edit and deletes the stored draft.
  function finish() {
    writeSummaryDraft(recording.id, null)
    onDone()
  }

  function save(baseVersion = base) {
    edit.mutate(
      { content_md: draft, base_version: baseVersion },
      {
        onSuccess: finish,
        onError: async (error) => {
          if (!isSummaryChanged(error)) return
          const fresh = (await latest.refetch()).data?.current
          if (fresh) setConflict({ version: fresh.version, content: fresh.content_md ?? '' })
        },
      },
    )
  }

  function cancel() {
    if (changed) setConfirm('discard')
    else finish()
  }

  return (
    <section className={styles.summary} aria-label={t('editor.label')}>
      <div className="doc-bar">
        <span className="kicker">{t('editor.kicker')}</span>
        <span>{t('editor.kept')}</span>
        <span className={styles.spacer} />
        {state.generated && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirm('revert')}>
            {t('editor.revert')}
          </button>
        )}
        <button type="button" className="btn btn-secondary btn-sm" onClick={cancel}>
          {t('common:cancel')}
        </button>
        <button type="button" className="btn btn-primary btn-sm" disabled={edit.isPending} onClick={() => save()}>
          {edit.isPending ? t('segment.saving') : t('common:save')}
        </button>
      </div>

      {conflict && (
        <div className="alert alert-warning" role="alert">
          <span>{t('editor.conflict', { version: conflict.version })}</span>
          <span className={styles.alertActions}>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShowConflict(!showConflict)}>
              {showConflict ? t('editor.closeCompare') : t('editor.seeVersion', { version: conflict.version })}
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => {
                setBase(conflict.version)
                setConflict(null)
                setShowConflict(false)
                save(conflict.version)
              }}
            >
              {t('editor.saveOver', { version: conflict.version })}
            </button>
          </span>
        </div>
      )}
      {edit.isError && !isSummaryChanged(edit.error) && (
        <p className="alert alert-error" role="alert">
          {errorMessage(edit.error)}
        </p>
      )}
      {conflict && showConflict && (
        <SummaryDiff before={draft} after={conflict.content} label={t('editor.diffLabel', { version: conflict.version })} />
      )}

      <div className={`doc doc-editing ${styles.doc}`}>
        <textarea
          ref={textRef}
          className={styles.editor}
          aria-label={t('editor.markdown')}
          value={draft}
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault()
              save()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              cancel()
            }
          }}
        />
      </div>
      <p className={styles.hint}>{t('segment.hint')}</p>

      {confirm === 'discard' && (
        <ConfirmDialog
          title={t('editor.discardTitle')}
          confirmLabel={t('editor.discard')}
          onCancel={() => setConfirm(null)}
          onConfirm={finish}
        >
          <p>{t('editor.discardText')}</p>
        </ConfirmDialog>
      )}
      {confirm === 'revert' && (
        <ConfirmDialog
          title={t('editor.revertTitle')}
          confirmLabel={t('editor.revert')}
          busy={revert.isPending}
          onCancel={() => setConfirm(null)}
          onConfirm={() => revert.mutate(undefined, { onSuccess: finish })}
        >
          <p>{t('editor.revertText')}</p>
          {revert.isError && (
            <p className="alert alert-error" role="alert">
              {errorMessage(revert.error)}
            </p>
          )}
        </ConfirmDialog>
      )}
      {leaveDialog}
    </section>
  )
}
