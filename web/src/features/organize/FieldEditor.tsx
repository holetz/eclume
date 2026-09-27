import { useEffect, useId, useState, type FormEvent } from 'react'
import { ApiError, errorMessage } from '../../api/problem'
import { Dialog } from '../../app/Dialog'
import { HelpHint } from '../../app/HelpHint'
import { FieldTest } from './FieldTest'
import styles from './Organize.module.css'
import {
  cleanDraft,
  KIND_LABELS,
  startFieldPreview,
  useDeleteField,
  useSaveField,
  type Field,
  type FieldDraft,
  type FieldKind,
} from './queries'
import { TagInput } from './TagInput'
import { usePreview } from './usePreview'

const EMPTY: FieldDraft = { name: '', kind: 'text', options: [], instructions: '', auto_fill: true }

function draftOf(field: Field | null): FieldDraft {
  if (!field) return EMPTY
  const { name, kind, options, instructions, auto_fill } = field
  return { name, kind, options, instructions, auto_fill }
}

function sameDraft(a: FieldDraft, b: FieldDraft): boolean {
  return JSON.stringify(cleanDraft(a)) === JSON.stringify(cleanDraft(b))
}

/** Os erros 422 do contrato por campo do formulário (`name`, `options`, `field.instructions`…). */
function invalidFields(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError) || error.problem?.code !== 'validation_failed') return {}
  const byField: Record<string, string> = {}
  for (const { field, message } of error.problem.errors ?? []) {
    byField[field.replace(/^field\./, '').replace(/\[\d+\]$/, '')] = message
  }
  return byField
}

interface FieldEditorProps {
  /** O campo salvo, ou `null` para o rascunho de um campo novo. */
  field: Field | null
  onDirtyChange: (dirty: boolean) => void
  onSaved: (field: Field) => void
  onDeleted: () => void
}

export function FieldEditor({ field, onDirtyChange, onSaved, onDeleted }: FieldEditorProps) {
  const id = useId()
  const initial = draftOf(field)
  const [draft, setDraft] = useState<FieldDraft>(initial)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const save = useSaveField()
  const test = usePreview(startFieldPreview)
  const builtin = field?.builtin != null
  const dirty = !sameDraft(draft, initial)
  const errors = invalidFields(save.error)
  const options = draft.options ?? []

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange])

  const set = (changes: Partial<FieldDraft>) => setDraft((current) => ({ ...current, ...changes }))
  const missingOptions = draft.kind === 'choice' && options.length === 0
  const complete = draft.name.trim() !== '' && !missingOptions
  const canSave = dirty && complete && !save.isPending
  const testing = test.state === 'queued' || test.state === 'running'

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!canSave) return
    save.mutate({ id: field?.id ?? null, draft: cleanDraft(draft) }, { onSuccess: onSaved })
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
  const describedBy = (name: string, hasText = false) =>
    errors[name] || hasText ? `${id}-${name}-hint` : undefined

  return (
    <form className="panel" onSubmit={submit} aria-label={field ? `Editar ${field.name}` : 'Novo campo'}>
      <div className={styles.panelHead}>
        <h4>{field ? field.name : 'Novo campo'}</h4>
        {field && !builtin && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(true)}>
            Excluir campo
          </button>
        )}
      </div>

      <div className="field">
        <label htmlFor={`${id}-name`}>Nome</label>
        <input
          id={`${id}-name`}
          className="input"
          value={draft.name}
          required
          aria-invalid={errors.name ? true : undefined}
          aria-describedby={describedBy('name')}
          onChange={(event) => set({ name: event.target.value })}
        />
        {hint('name')}
      </div>

      <fieldset className={`field ${styles.fieldset}`} aria-describedby={describedBy('kind', builtin)}>
        <legend className="field-label">Tipo</legend>
        <div className="seg">
          {(Object.keys(KIND_LABELS) as FieldKind[]).map((kind) => (
            <label key={kind} className="seg-opt">
              <input
                type="radio"
                name={`${id}-kind`}
                value={kind}
                checked={draft.kind === kind}
                disabled={builtin}
                onChange={() => set({ kind })}
              />
              {KIND_LABELS[kind]}
            </label>
          ))}
        </div>
        {hint('kind', builtin ? 'O tipo de um campo embutido não muda.' : undefined)}
      </fieldset>

      {draft.kind === 'choice' && (
        <div className="field">
          <label htmlFor={`${id}-options`}>Opções</label>
          <TagInput
            id={`${id}-options`}
            value={options}
            onChange={(value) => set({ options: value })}
            listLabel="Opções"
            itemLabel="opção"
            invalid={Boolean(errors.options)}
            describedBy={describedBy('options', true)}
          />
          {hint('options', 'Ao menos uma. O agente escolhe uma delas, ou deixa vazio.')}
        </div>
      )}

      <div className="field">
        <div className={styles.labelRow}>
          <label htmlFor={`${id}-instructions`}>Como identificar</label>
          <HelpHint subject="como escrever uma regra" title="Como escrever uma regra" article="escrever-uma-regra">
            Diga o que procurar na conversa, a forma do valor e quando deixar vazio. O agente segue a
            regra depois de cada transcrição.
          </HelpHint>
        </div>
        <textarea
          id={`${id}-instructions`}
          className={`input ${styles.instructions}`}
          value={draft.instructions ?? ''}
          aria-invalid={errors.instructions ? true : undefined}
          aria-describedby={describedBy('instructions')}
          onChange={(event) => set({ instructions: event.target.value })}
        />
        {hint('instructions')}
      </div>

      <label className="switch">
        <input
          type="checkbox"
          checked={draft.auto_fill ?? true}
          onChange={(event) => set({ auto_fill: event.target.checked })}
        />
        <span className="track" />
        Preencher automaticamente depois da transcrição
      </label>

      {save.isError && !Object.keys(errors).length && (
        <p className="alert alert-error" role="alert">
          {errorMessage(save.error)}
        </p>
      )}

      <FieldTest test={test} />

      <div className="row">
        <button type="submit" className="btn btn-primary" disabled={!canSave}>
          {save.isPending ? 'Salvando…' : 'Salvar'}
        </button>
        {/* Testa o rascunho como está, sem salvar. */}
        <button
          type="button"
          className="btn btn-secondary"
          disabled={!complete || testing}
          onClick={() => test.run({ field: cleanDraft(draft) })}
        >
          Testar numa gravação
        </button>
      </div>

      {confirmDelete && field && (
        <DeleteFieldDialog field={field} onClose={() => setConfirmDelete(false)} onDeleted={onDeleted} />
      )}
    </form>
  )
}

function DeleteFieldDialog({ field, onClose, onDeleted }: { field: Field; onClose: () => void; onDeleted: () => void }) {
  const remove = useDeleteField()
  return (
    <Dialog
      title={`Excluir ${field.name}?`}
      message="O campo sai de todas as gravações, com os valores já preenchidos."
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
            onClick={() => remove.mutateAsync(field.id).then(onDeleted, () => {})}
          >
            Excluir campo
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
