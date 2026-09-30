import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { errorMessage } from '../../api/problem'
import { Dialog } from '../../app/Dialog'
import { HelpHint } from '../../app/HelpHint'
import { AgendaPreviewResult, RecordingPicker } from './AgendaTypePreview'
import styles from './Organize.module.css'
import {
  invalidFields,
  startAgendaTypePreview,
  useDeleteAgendaType,
  useFields,
  useSaveAgendaType,
  type AgendaType,
  type AgendaTypeDraft,
} from './queries'
import { TagInput } from './TagInput'
import { usePreview } from './usePreview'

const EMPTY: AgendaTypeDraft = {
  name: '',
  title_pattern: null,
  title_instructions: '',
  identify: '',
  default_tags: [],
  summary_instructions: '',
}

// Os marcadores que todo padrão de título aceita; os campos do usuário entram pela chave.
const BASE_MARKERS = ['{assunto}', '{data}', '{tipo}']

function draftOf(type: AgendaType | null): AgendaTypeDraft {
  if (!type) return EMPTY
  const { name, title_pattern, title_instructions, identify, default_tags, summary_instructions } = type
  return { name, title_pattern, title_instructions, identify, default_tags, summary_instructions }
}

/** O rascunho no formato do contrato: sem espaços nas pontas do nome, e padrão vazio vira `null`. */
function cleanDraft(draft: AgendaTypeDraft): AgendaTypeDraft {
  return { ...draft, name: draft.name.trim(), title_pattern: draft.title_pattern?.trim() || null }
}

interface AgendaTypeEditorProps {
  /** O tipo salvo, ou `null` para o rascunho de um tipo novo. */
  type: AgendaType | null
  onDirtyChange: (dirty: boolean) => void
  onSaved: (type: AgendaType) => void
  onDeleted: () => void
}

export function AgendaTypeEditor({ type, onDirtyChange, onSaved, onDeleted }: AgendaTypeEditorProps) {
  const id = useId()
  const initial = draftOf(type)
  const [draft, setDraft] = useState<AgendaTypeDraft>(initial)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [picking, setPicking] = useState(false)
  // O rascunho que a pré-visualização em tela usou: editar depois disso a invalida.
  const [previewedDraft, setPreviewedDraft] = useState<string | null>(null)
  const save = useSaveAgendaType()
  const preview = usePreview(startAgendaTypePreview)
  const fields = useFields()
  const titleInput = useRef<HTMLInputElement>(null)
  const errors = invalidFields(save.error)
  const draftKey = JSON.stringify(cleanDraft(draft))
  const dirty = draftKey !== JSON.stringify(cleanDraft(initial))
  const complete = draft.name.trim() !== '' && draft.summary_instructions.trim() !== ''
  const canSave = dirty && complete && !save.isPending
  const previewing = preview.state === 'queued' || preview.state === 'running'
  // O tipo padrão fica com a gravação quando nenhum outro se encaixa: não sai e não concorre.
  const fallback = type?.fallback === true
  const markers = [
    ...BASE_MARKERS,
    ...(fields.data?.items ?? []).filter((field) => !field.builtin).map((field) => `{${field.key}}`),
  ]

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange])

  const set = (changes: Partial<AgendaTypeDraft>) => setDraft((current) => ({ ...current, ...changes }))

  /** Insere o marcador na posição do cursor do padrão de título e devolve o foco a ele. */
  function insertMarker(marker: string) {
    const input = titleInput.current
    const value = draft.title_pattern ?? ''
    const start = input?.selectionStart ?? value.length
    const end = input?.selectionEnd ?? value.length
    set({ title_pattern: value.slice(0, start) + marker + value.slice(end) })
    requestAnimationFrame(() => {
      input?.focus()
      input?.setSelectionRange(start + marker.length, start + marker.length)
    })
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (canSave) save.mutate({ id: type?.id ?? null, draft: cleanDraft(draft) }, { onSuccess: onSaved })
  }

  const hint = (name: string, text?: string) => {
    const message = errors[name]
    if (!message && !text) return null
    return (
      <span id={`${id}-${name}-hint`} className={message ? `field-hint ${styles.error}` : 'field-hint'}>
        {message ?? text}
      </span>
    )
  }
  const invalid = (name: string) => (errors[name] ? true : undefined)

  return (
    <form className="panel" onSubmit={submit} aria-label={type ? `Editar ${type.name}` : 'Novo tipo'}>
      <div className={styles.panelHead}>
        <h4>
          {type ? type.name : 'Novo tipo'}
          {fallback && <span className={`badge ${styles.badge}`}>Padrão</span>}
        </h4>
        {type && !fallback && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(true)}>
            Excluir tipo
          </button>
        )}
      </div>

      <div className={styles.pair}>
        <div className="field">
          <label htmlFor={`${id}-name`}>Nome</label>
          <input
            id={`${id}-name`}
            className="input"
            value={draft.name}
            required
            aria-invalid={invalid('name')}
            aria-describedby={errors.name ? `${id}-name-hint` : undefined}
            onChange={(event) => set({ name: event.target.value })}
          />
          {hint('name')}
        </div>
        <div className="field">
          <div className={styles.labelRow}>
            <label htmlFor={`${id}-title`}>Título da gravação</label>
            <HelpHint subject="como montar o título" title="Como montar o título" article="padrao-de-titulo">
              Monte o título com os marcadores. Um marcador sem valor some junto com o separador ao lado.
            </HelpHint>
          </div>
          <input
            ref={titleInput}
            id={`${id}-title`}
            className={`input mono ${styles.mono}`}
            value={draft.title_pattern ?? ''}
            placeholder="{tipo} · {assunto}"
            aria-invalid={invalid('title_pattern')}
            aria-describedby={errors.title_pattern ? `${id}-title_pattern-hint` : undefined}
            onChange={(event) => set({ title_pattern: event.target.value })}
          />
          {hint('title_pattern')}
        </div>
      </div>
      <div className={styles.markers} role="group" aria-label="Marcadores do título">
        {markers.map((marker) => (
          <button
            key={marker}
            type="button"
            className={`tag tag-outline mono ${styles.marker}`}
            aria-label={`Inserir ${marker}`}
            onClick={() => insertMarker(marker)}
          >
            {marker}
          </button>
        ))}
      </div>

      <div className="field">
        <div className={styles.labelRow}>
          <label htmlFor={`${id}-title-rule`}>Como escrever o assunto</label>
          <HelpHint subject="a regra do assunto" title="A regra do assunto" article="padrao-de-titulo">
            O agente escreve o {'{assunto}'} do título seguindo esta regra. Vazia, vale a do tipo padrão.
          </HelpHint>
        </div>
        <textarea
          id={`${id}-title-rule`}
          className={`input ${styles.identify}`}
          value={draft.title_instructions ?? ''}
          placeholder={fallback ? undefined : 'Vazia: vale a regra do tipo padrão.'}
          aria-invalid={invalid('title_instructions')}
          aria-describedby={`${id}-title_instructions-hint`}
          onChange={(event) => set({ title_instructions: event.target.value })}
        />
        {hint(
          'title_instructions',
          fallback ? 'Vale também para os tipos sem regra própria.' : 'Por exemplo: “o cliente e o assunto principal”.',
        )}
      </div>

      {fallback ? (
        <p className={`field-hint ${styles.fallbackNote}`}>
          Este é o tipo padrão: a gravação fica com ele quando nenhum outro tipo se encaixa com confiança. Ele não
          tem “Como identificar” e não pode ser excluído.
        </p>
      ) : (
        <div className="field">
          <label htmlFor={`${id}-identify`}>Como identificar</label>
          <textarea
            id={`${id}-identify`}
            className={`input ${styles.identify}`}
            value={draft.identify ?? ''}
            aria-invalid={invalid('identify')}
            aria-describedby={`${id}-identify-hint`}
            onChange={(event) => set({ identify: event.target.value })}
          />
          {hint('identify', 'Depois da transcrição, um agente lê isto e escolhe o tipo.')}
        </div>
      )}

      <div className="field">
        <label htmlFor={`${id}-tags`}>Tags padrão</label>
        <TagInput
          id={`${id}-tags`}
          value={draft.default_tags ?? []}
          onChange={(value) => set({ default_tags: value })}
          listLabel="Tags padrão"
          itemLabel="tag"
          invalid={Boolean(errors.default_tags)}
          describedBy={`${id}-default_tags-hint`}
        />
        {hint('default_tags', 'Somadas às tags automáticas.')}
      </div>

      <div className="field">
        <label htmlFor={`${id}-instructions`}>Instruções do resumo</label>
        <textarea
          id={`${id}-instructions`}
          className={`input mono ${styles.mono} ${styles.summaryInstructions}`}
          value={draft.summary_instructions}
          required
          aria-invalid={invalid('summary_instructions')}
          aria-describedby={`${id}-summary_instructions-hint`}
          onChange={(event) => set({ summary_instructions: event.target.value })}
        />
        {hint('summary_instructions', 'Em Markdown. O resumo segue estas instruções.')}
      </div>

      {save.isError && !Object.keys(errors).length && (
        <p className="alert alert-error" role="alert">
          {errorMessage(save.error)}
        </p>
      )}

      <AgendaPreviewResult preview={preview} stale={previewedDraft !== null && previewedDraft !== draftKey} />

      <div className={styles.actions}>
        <button type="submit" className="btn btn-primary" disabled={!canSave}>
          {save.isPending ? 'Salvando…' : 'Salvar'}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={!complete || previewing}
          onClick={() => setPicking(true)}
        >
          Pré-visualizar numa gravação
        </button>
      </div>

      {picking && (
        <RecordingPicker
          onClose={() => setPicking(false)}
          onPick={(recordingId) => {
            setPicking(false)
            setPreviewedDraft(draftKey)
            preview.run({ agenda_type: cleanDraft(draft), recording_id: recordingId, agenda_type_id: type?.id ?? null })
          }}
        />
      )}
      {confirmDelete && type && (
        <DeleteAgendaTypeDialog type={type} onClose={() => setConfirmDelete(false)} onDeleted={onDeleted} />
      )}
    </form>
  )
}

function DeleteAgendaTypeDialog({
  type,
  onClose,
  onDeleted,
}: {
  type: AgendaType
  onClose: () => void
  onDeleted: () => void
}) {
  const remove = useDeleteAgendaType()
  return (
    <Dialog
      plain
      title={`Excluir ${type.name}?`}
      message="As gravações deste tipo passam para o tipo padrão. Os resumos já feitos continuam."
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Manter
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={remove.isPending}
            // A lista recarrega antes do fim do mutate e desmonta este painel: a promessa segue mesmo assim.
            onClick={() => remove.mutateAsync(type.id).then(onDeleted, () => {})}
          >
            Excluir tipo
          </button>
        </>
      }
    >
      {remove.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(remove.error)}
        </p>
      )}
    </Dialog>
  )
}
