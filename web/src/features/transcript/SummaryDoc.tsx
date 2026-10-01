import { Copy } from 'lucide-react'
import { useId, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { safeMarkdown } from '../../app/markdown'
import type { Schemas } from '../../api/client'
import { errorMessage } from '../../api/problem'
import { ConfirmDialog } from '../../app/ConfirmDialog'
import { Dialog } from '../../app/Dialog'
import { useAgendaTypes } from '../organize/queries'
import { summaryClipboard } from './copy-summary'
import styles from './RecordingPage.module.css'
import { isMissingProvider, isMissingType, originLabel, useSummaryMutations, useSummaryState } from './summary'
import { SummaryDiff, SummaryEditor } from './SummaryEditor'
import { motivo } from '../../lib/vocabulario.js'

type Recording = Schemas['Recording']

// O `# Ata ...` do resumo vira h2: a página já tem o título da gravação como h1.
const MARKDOWN = safeMarkdown({
  h1: ({ children }) => <h2 className={styles.docTitle}>{children}</h2>,
})

interface ChangeTypeDialogProps {
  recording: Recording
  onClose: () => void
}

/** Trocar o tipo de agenda da gravação: gera um resumo novo pelas instruções do tipo escolhido. */
export function ChangeTypeDialog({ recording, onClose }: ChangeTypeDialogProps) {
  const types = useAgendaTypes()
  const { changeType } = useSummaryMutations(recording)
  const [chosen, setChosen] = useState(recording.agenda_type?.id ?? '')
  const selectId = useId()
  return (
    <Dialog
      title="Trocar o tipo de agenda"
      plain
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancelar
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!chosen || chosen === recording.agenda_type?.id || changeType.isPending}
            onClick={() => changeType.mutate(chosen, { onSuccess: onClose })}
          >
            {changeType.isPending ? 'Trocando…' : 'Trocar e gerar'}
          </button>
        </>
      }
    >
      <div className={styles.dialogStack}>
        <div className="field">
          <label htmlFor={selectId} className="field-label">
            Tipo de agenda
          </label>
          <select id={selectId} className="input" value={chosen} onChange={(event) => setChosen(event.target.value)}>
            <option value="" disabled>
              Escolha um tipo
            </option>
            {types.data?.items.map((type) => (
              <option key={type.id} value={type.id}>
                {type.name}
              </option>
            ))}
          </select>
        </div>
        <p className="text-muted">Trocar o tipo gera um resumo novo pelas instruções do tipo; a versão atual fica guardada.</p>
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

/** Confirma gerar outra versão pelo tipo de agenda da gravação: a nova passa a ser a atual. */
function RegenerateDialog({ typeName, current, busy, error, onConfirm, onClose }: RegenerateDialogProps) {
  return (
    <Dialog
      title="Regenerar o resumo?"
      plain
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancelar
          </button>
          <button type="button" className="btn btn-primary" disabled={busy} aria-busy={busy} onClick={onConfirm}>
            {busy ? 'Enfileirando…' : 'Regenerar'}
          </button>
        </>
      }
    >
      <div className={styles.dialogStack}>
        <p>
          Gera uma versão nova pelas instruções de {typeName ?? 'o tipo de agenda'}. A nova versão passa a ser a atual; a
          versão {current.version} ({originLabel(current)}) fica guardada.
        </p>
        {error != null && (
          <p className="alert alert-error" role="alert">
            {errorMessage(error)}
          </p>
        )}
      </div>
    </Dialog>
  )
}

const NO_PROVIDER = `Sem resumo: ${motivo('no_provider')}.`

interface SummaryDocProps {
  recording: Recording
  onChangeType: () => void
}

/** O documento do resumo com a `.doc-bar` (tipo, origem e versão, e as ações) e os estados da geração. */
export function SummaryDoc({ recording, onChangeType }: SummaryDocProps) {
  const state = useSummaryState(recording.id, recording.transcript_id !== null)
  const { remove, generate } = useSummaryMutations(recording)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [confirmingRegenerate, setConfirmingRegenerate] = useState(false)
  const [mode, setMode] = useState<'read' | 'edit' | 'compare'>('read')
  const [copied, setCopied] = useState<'ok' | 'error' | null>(null)

  if (recording.transcript_id === null) return null
  if (state.isPending) return <p role="status">Carregando o resumo…</p>
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
  // Sem agente de resumo, o motivo no lugar do "Gerar resumo" primário; o retentar fica para depois que alguém configurar um.
  const noProvider = summaryStep?.state === 'skipped' && summaryStep.reason === 'no_provider'

  async function copy() {
    setCopied(null)
    try {
      const content = summaryClipboard(recording.title, current?.content_md ?? '')
      // Sem `ClipboardItem` (navegador antigo), só o texto; o Teams cola o HTML em negrito.
      if (typeof ClipboardItem === 'undefined') await navigator.clipboard.writeText((await content).text)
      else {
        // O item nasce ainda no clique, com o conteúdo como promessa: o Safari recusa a escrita
        // começada depois de um `await`.
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
      <section className={styles.summary} aria-label="Resumo">
        {pending ? (
          <p className={styles.docState} aria-busy="true" role="status">
            Resumindo pelas instruções de {typeName ?? 'o tipo de agenda'}…
          </p>
        ) : (
          <div className={styles.docState}>
            {summaryStep?.state === 'failed' ? (
              <p className="alert alert-error" role="alert">
                {summaryStep.error?.message ?? 'A geração do resumo falhou.'}
              </p>
            ) : (
              <p>{noProvider ? NO_PROVIDER : 'Sem resumo.'}</p>
            )}
            <button
              type="button"
              className={`btn ${noProvider ? 'btn-secondary' : 'btn-primary'} btn-sm`}
              disabled={generate.isPending}
              onClick={startGenerate}
            >
              {summaryStep?.state === 'failed' || noProvider ? 'Tentar de novo' : 'Gerar resumo'}
            </button>
            {generate.isError && (
              <p className="alert alert-error" role="alert">
                {isMissingType(generate.error)
                  ? 'Escolha um tipo de agenda para gerar o resumo.'
                  : isMissingProvider(generate.error)
                    ? NO_PROVIDER
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

  return (
    <section className={styles.summary} aria-label="Resumo">
      <div className="doc-bar">
        <span className="tag tag-neutral">Tipo · {current.agenda_type?.name ?? typeName ?? 'sem tipo'}</span>
        <span>
          {originLabel(current)} · versão {current.version}
        </span>
        <span className={styles.spacer} />
        <button type="button" className="btn btn-secondary btn-sm" title="Copia o título e o resumo" onClick={copy}>
          <Copy size={14} aria-hidden />
          Copiar com título
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMode('edit')}>
          Editar
        </button>
        {comparable && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-pressed={mode === 'compare'}
            onClick={() => setMode(mode === 'compare' ? 'read' : 'compare')}
          >
            {mode === 'compare' ? 'Fechar comparação' : 'Comparar com a gerada'}
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
          Regenerar
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onChangeType}>
          Trocar tipo
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmingDelete(true)}>
          Excluir resumo
        </button>
      </div>
      <p className="visually-hidden" role="status">
        {copied === 'ok' ? 'Copiado' : ''}
      </p>
      {copied === 'error' && (
        <p className="alert alert-error" role="alert">
          Não deu para copiar: o navegador não liberou a área de transferência.
        </p>
      )}
      {pending && (
        <p className={styles.docPending} role="status">
          Gerando uma versão nova…
        </p>
      )}
      {mode === 'compare' && comparable ? (
        <SummaryDiff
          before={generated.content_md ?? ''}
          after={current.content_md ?? ''}
          label={`A gerada (versão ${generated.version}) e a atual (versão ${current.version})`}
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
          title="Excluir o resumo?"
          confirmLabel="Excluir resumo"
          busy={remove.isPending}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => remove.mutate(undefined, { onSuccess: () => setConfirmingDelete(false) })}
        >
          <p>Todas as versões e o chat de ajuste são apagados. A transcrição fica.</p>
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
