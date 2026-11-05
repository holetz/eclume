import { Copy } from 'lucide-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import { Link } from 'react-router'
import { safeMarkdown } from '../../app/markdown'
import { i18n } from '../../i18n'
import type { Schemas } from '../../api/client'
import { errorMessage } from '../../api/problem'
import { ConfirmDialog } from '../../app/ConfirmDialog'
import { Dialog } from '../../app/Dialog'
import { useAgendaTypes } from '../organize/queries'
import { summaryClipboard } from './copy-summary'
import styles from './RecordingPage.module.css'
import { isMissingProvider, isMissingType, originLabel, useSummaryMutations, useSummaryState } from './summary'
import { SummaryDiff, SummaryEditor } from './SummaryEditor'
import { reasonText } from '../../shared/format'

type Recording = Schemas['Recording']

// The summary's `# Ata ...` becomes h2: the page already has the recording title as h1.
const MARKDOWN = safeMarkdown({
  h1: ({ children }) => <h2 className={styles.docTitle}>{children}</h2>,
})

interface ChangeTypeDialogProps {
  recording: Recording
  onClose: () => void
}

/** Switching the recording's agenda type: generates a new summary from the instructions of the chosen agenda type. */
export function ChangeTypeDialog({ recording, onClose }: ChangeTypeDialogProps) {
  const types = useAgendaTypes()
  const { changeType } = useSummaryMutations(recording)
  const [chosen, setChosen] = useState(recording.agenda_type?.id ?? '')
  const { t } = useTranslation(['transcript', 'common'])
  const selectId = useId()
  return (
    <Dialog
      title={t('summary.changeTypeTitle')}
      plain
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            {t('common:cancel')}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!chosen || chosen === recording.agenda_type?.id || changeType.isPending}
            onClick={() => changeType.mutate(chosen, { onSuccess: onClose })}
          >
            {changeType.isPending ? t('summary.changing') : t('summary.changeAndGenerate')}
          </button>
        </>
      }
    >
      <div className={styles.dialogStack}>
        <div className="field">
          <label htmlFor={selectId} className="field-label">
            {t('summary.agendaType')}
          </label>
          <select id={selectId} className="input" value={chosen} onChange={(event) => setChosen(event.target.value)}>
            <option value="" disabled>
              {t('summary.chooseType')}
            </option>
            {types.data?.items.map((type) => (
              <option key={type.id} value={type.id}>
                {type.name}
              </option>
            ))}
          </select>
        </div>
        <p className="text-muted">{t('summary.changeTypeText')}</p>
        {changeType.isError && (
          <p className="alert alert-error" role="alert">
            {errorMessage(changeType.error)}
          </p>
        )}
      </div>
    </Dialog>
  )
}

interface RegenerateDialogProps {
  typeName: string | null
  current: Pick<Schemas['Summary'], 'version' | 'origin' | 'restored_from_id'>
  busy: boolean
  error: unknown
  onConfirm: () => void
  onClose: () => void
}

/** Confirms generating another version from the recording's agenda type: the new one becomes the current one. */
function RegenerateDialog({ typeName, current, busy, error, onConfirm, onClose }: RegenerateDialogProps) {
  const { t } = useTranslation(['transcript', 'common'])
  const values = { type: typeName ?? '', version: current.version, origin: originLabel(current) }
  return (
    <Dialog
      title={t('summary.regenerateTitle')}
      plain
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            {t('common:cancel')}
          </button>
          <button type="button" className="btn btn-primary" disabled={busy} aria-busy={busy} onClick={onConfirm}>
            {busy ? t('summary.queueing') : t('summary.regenerate')}
          </button>
        </>
      }
    >
      <div className={styles.dialogStack}>
        <p>{typeName ? t('summary.regenerateText', values) : t('summary.regenerateTextNoType', values)}</p>
        {error != null && (
          <p className="alert alert-error" role="alert">
            {errorMessage(error)}
          </p>
        )}
      </div>
    </Dialog>
  )
}

const noProviderText = () => i18n.t('transcript:summary.noProvider', { reason: reasonText('no_provider') })

interface SummaryDocProps {
  recording: Recording
  /** The `revision` of the transcript already loaded; `undefined` while it has not arrived. */
  transcriptRevision?: number
  onChangeType: () => void
}

/** The summary document with the `.doc-bar` (agenda type, origin and version, and the actions) and the generation states. */
export function SummaryDoc({ recording, transcriptRevision, onChangeType }: SummaryDocProps) {
  const state = useSummaryState(recording.id, recording.transcript_id !== null)
  const { remove, generate } = useSummaryMutations(recording)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [confirmingRegenerate, setConfirmingRegenerate] = useState(false)
  const [mode, setMode] = useState<'read' | 'edit' | 'compare'>('read')
  const [copied, setCopied] = useState<'ok' | 'error' | null>(null)
  const agendaTypes = useAgendaTypes()
  const { t } = useTranslation(['transcript', 'common'])

  if (recording.transcript_id === null) return null
  if (state.isPending) return <p role="status">{t('summary.loading')}</p>
  if (state.isError) {
    return (
      <p className="alert alert-error" role="alert">
        {errorMessage(state.error)}
      </p>
    )
  }

  const { current, pending } = state.data
  const typeName = pending?.agenda_type?.name ?? recording.agenda_type?.name ?? null
  const summaryStep = recording.pipeline.find((step) => step.step === 'summary')
  // With no summary agent, the reason in place of the primary "Gerar resumo"; the retry waits until someone configures one.
  const noProvider = summaryStep?.state === 'skipped' && summaryStep.reason === 'no_provider'

  async function copy() {
    setCopied(null)
    try {
      const content = summaryClipboard(recording.title, current?.content_md ?? '')
      // Without `ClipboardItem` (old browser), only the text; Teams pastes the HTML in bold.
      if (typeof ClipboardItem === 'undefined') await navigator.clipboard.writeText((await content).text)
      else {
        // The item is created still within the click, with the content as a promise: Safari refuses a write
        // started after an `await`.
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/html': content.then(({ html }) => new Blob([html], { type: 'text/html' })),
            'text/plain': content.then(({ text }) => new Blob([text], { type: 'text/plain' })),
          }),
        ])
      }
      setCopied('ok')
    } catch {
      setCopied('error')
    }
  }

  // Only warns with the transcript revision in hand and with no new version on the way.
  const stale =
    current != null && pending === null && transcriptRevision !== undefined && current.transcript_revision < transcriptRevision

  function regenerate() {
    generate.mutate(undefined, {
      onSuccess: () => setConfirmingRegenerate(false),
      onError: (error) => {
        if (!isMissingType(error)) return
        setConfirmingRegenerate(false)
        onChangeType()
      },
    })
  }

  function startGenerate() {
    generate.mutate(undefined, {
      onError: (error) => {
        if (isMissingType(error)) onChangeType()
      },
    })
  }

  if (!current) {
    return (
      <section className={styles.summary} aria-label={t('summary.label')}>
        {pending ? (
          <p className={styles.docState} aria-busy="true" role="status">
            {typeName ? t('summary.summarizing', { type: typeName }) : t('summary.summarizingNoType')}
          </p>
        ) : (
          <div className={styles.docState}>
            {summaryStep?.state === 'failed' ? (
              <p className="alert alert-error" role="alert">
                {summaryStep.error?.message ?? t('summary.failed')}
              </p>
            ) : (
              <p>{noProvider ? noProviderText() : t('summary.none')}</p>
            )}
            <button
              type="button"
              className={`btn ${noProvider ? 'btn-secondary' : 'btn-primary'} btn-sm`}
              disabled={generate.isPending}
              onClick={startGenerate}
            >
              {summaryStep?.state === 'failed' || noProvider ? t('common:retry') : t('summary.generate')}
            </button>
            {generate.isError && (
              <p className="alert alert-error" role="alert">
                {isMissingType(generate.error)
                  ? t('summary.missingType')
                  : isMissingProvider(generate.error)
                    ? noProviderText()
                    : errorMessage(generate.error)}
              </p>
            )}
          </div>
        )}
      </section>
    )
  }

  if (mode === 'edit') return <SummaryEditor recording={recording} state={state.data} onDone={() => setMode('read')} />

  const { generated } = state.data
  const comparable = generated !== null && generated.id !== current.id
  // The badge is the snapshot of the agenda type in the summary: it only becomes a link if the agenda type still exists.
  const typeLabel = t('summary.typeLabel', { type: current.agenda_type?.name ?? typeName ?? t('summary.noType') })
  const liveTypeId = agendaTypes.data?.items.find((type) => type.id === current.agenda_type?.id)?.id

  return (
    <section className={styles.summary} aria-label={t('summary.label')}>
      <div className="doc-bar">
        {liveTypeId ? (
          <Link
            to={`/config/agendas?tipo=${liveTypeId}`}
            className="tag tag-neutral"
            title={t('summary.adjustModel')}
            aria-label={t('summary.adjustModelLabel', { type: typeLabel })}
          >
            {typeLabel}
          </Link>
        ) : (
          <span className="tag tag-neutral">{typeLabel}</span>
        )}
        <span>
          {t('summary.versionLine', { origin: originLabel(current), version: current.version })}
        </span>
        <span className={styles.spacer} />
        <button type="button" className="btn btn-secondary btn-sm" title={t('summary.copyTitle')} onClick={copy}>
          <Copy size={14} aria-hidden />
          {t('summary.copy')}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMode('edit')}>
          {t('summary.edit')}
        </button>
        {comparable && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-pressed={mode === 'compare'}
            onClick={() => setMode(mode === 'compare' ? 'read' : 'compare')}
          >
            {mode === 'compare' ? t('summary.closeCompare') : t('summary.compare')}
          </button>
        )}
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={pending !== null || generate.isPending}
          onClick={() => {
            generate.reset()
            setConfirmingRegenerate(true)
          }}
        >
          {t('summary.regenerate')}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onChangeType}>
          {t('summary.changeType')}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmingDelete(true)}>
          {t('summary.delete')}
        </button>
      </div>
      <p className="visually-hidden" role="status">
        {copied === 'ok' ? t('summary.copied') : ''}
      </p>
      {copied === 'error' && (
        <p className="alert alert-error" role="alert">
          {t('summary.copyFailed')}
        </p>
      )}
      {stale && (
        <p className="alert alert-warning" role="status">
          <span className="alert-title">{t('summary.staleTitle')}</span>
          <span>{t('summary.staleText')}</span>
        </p>
      )}
      {pending && (
        <p className={styles.docPending} role="status">
          {t('summary.pending')}
        </p>
      )}
      {mode === 'compare' && comparable ? (
        <SummaryDiff
          before={generated.content_md ?? ''}
          after={current.content_md ?? ''}
          label={t('summary.compareLabel', { generated: generated.version, current: current.version })}
        />
      ) : (
        <div className={`doc ${styles.doc}`}>
          <ReactMarkdown components={MARKDOWN}>{current.content_md ?? ''}</ReactMarkdown>
        </div>
      )}
      {confirmingRegenerate && (
        <RegenerateDialog
          typeName={current.agenda_type?.name ?? typeName}
          current={current}
          busy={generate.isPending}
          error={generate.isError && !isMissingType(generate.error) ? generate.error : null}
          onConfirm={regenerate}
          onClose={() => setConfirmingRegenerate(false)}
        />
      )}
      {confirmingDelete && (
        <ConfirmDialog
          title={t('summary.deleteTitle')}
          confirmLabel={t('summary.delete')}
          busy={remove.isPending}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => remove.mutate(undefined, { onSuccess: () => setConfirmingDelete(false) })}
        >
          <p>{t('summary.deleteText')}</p>
          {remove.isError && (
            <p className="alert alert-error" role="alert">
              {errorMessage(remove.error)}
            </p>
          )}
        </ConfirmDialog>
      )}
    </section>
  )
}
