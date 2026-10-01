import { useEffect, useLayoutEffect, useRef, useState } from 'react'
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

/** As linhas de duas versões lado a lado no tempo: removidas em `<del>` e incluídas em `<ins>`. */
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
 * A edição do resumo (frame "editing the summary"): o Markdown na tipografia do documento, salvo como
 * versão nova sobre a versão aberta. Se outra versão entrou nesse meio-tempo (409), o rascunho fica e
 * a pessoa escolhe ver a nova ou salvar sobre ela.
 */
export function SummaryEditor({ recording, state, onDone }: SummaryEditorProps) {
  const { edit, revert } = useSummaryMutations(recording)
  const latest = useSummaryState(recording.id)
  const opened = state.current
  // O rascunho guardado volta ao reabrir; se a versão andou desde então, volta com o aviso de conflito.
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
    title: 'Descartar a edição?',
    message: <p>As mudanças deste rascunho se perdem.</p>,
    onDiscard: () => writeSummaryDraft(recording.id, null),
  })

  // A área cresce com o conteúdo, como o documento.
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

  // Salvar, descartar ou voltar à gerada encerram a edição e apagam o rascunho guardado.
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
    <section className={styles.summary} aria-label="Editando o resumo">
      <div className="doc-bar">
        <span className="kicker">Editando</span>
        <span>A versão gerada fica guardada</span>
        <span className={styles.spacer} />
        {state.generated && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirm('revert')}>
            Voltar à gerada
          </button>
        )}
        <button type="button" className="btn btn-secondary btn-sm" onClick={cancel}>
          Cancelar
        </button>
        <button type="button" className="btn btn-primary btn-sm" disabled={edit.isPending} onClick={() => save()}>
          {edit.isPending ? 'Salvando…' : 'Salvar'}
        </button>
      </div>

      {conflict && (
        <div className="alert alert-warning" role="alert">
          <span>O resumo mudou enquanto você editava (agora na versão {conflict.version}).</span>
          <span className={styles.alertActions}>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShowConflict(!showConflict)}>
              {showConflict ? 'Fechar a comparação' : `Ver a versão ${conflict.version}`}
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
              Salvar sobre a versão {conflict.version}
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
        <SummaryDiff before={draft} after={conflict.content} label={`Seu rascunho e a versão ${conflict.version}`} />
      )}

      <div className={`doc doc-editing ${styles.doc}`}>
        <textarea
          ref={textRef}
          className={styles.editor}
          aria-label="Resumo em Markdown"
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
      <p className={styles.hint}>Ctrl+Enter salva · Esc cancela</p>

      {confirm === 'discard' && (
        <ConfirmDialog
          title="Descartar a edição?"
          confirmLabel="Descartar"
          onCancel={() => setConfirm(null)}
          onConfirm={finish}
        >
          <p>As mudanças deste rascunho se perdem.</p>
        </ConfirmDialog>
      )}
      {confirm === 'revert' && (
        <ConfirmDialog
          title="Voltar à versão gerada?"
          confirmLabel="Voltar à gerada"
          busy={revert.isPending}
          onCancel={() => setConfirm(null)}
          onConfirm={() => revert.mutate(undefined, { onSuccess: finish })}
        >
          <p>O rascunho é descartado, e a versão gerada volta como uma versão nova. Nada se perde.</p>
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
