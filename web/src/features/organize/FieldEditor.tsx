import { useEffect, useId, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { errorMessage } from '../../api/problem'
import { Dialog } from '../../app/Dialog'
import { HelpHint } from '../../app/HelpHint'
import { FieldTest } from './FieldTest'
import styles from './Organize.module.css'
import {
  cleanDraft,
  invalidFields,
  FIELD_KINDS,
  kindLabel,
  startFieldPreview,
  useDeleteField,
  useSaveField,
  type Field,
  type FieldDraft,
} from './queries'
import { TagInput } from './TagInput'
import { usePreview } from './usePreview'
import { Switch } from '../../shared/Switch'

const EMPTY: FieldDraft = { name: '', kind: 'text', options: [], instructions: '', auto_fill: true }

function draftOf(field: Field | null): FieldDraft {
  if (!field) return EMPTY
  const { name, kind, options, instructions, auto_fill } = field
  return { name, kind, options, instructions, auto_fill }
}

function sameDraft(a: FieldDraft, b: FieldDraft): boolean {
  return JSON.stringify(cleanDraft(a)) === JSON.stringify(cleanDraft(b))
}

interface FieldEditorProps {
  /** The saved field, or `null` for the draft of a new field. */
  field: Field | null
  onDirtyChange: (dirty: boolean) => void
  onSaved: (field: Field) => void
  onDeleted: () => void
}

export function FieldEditor({ field, onDirtyChange, onSaved, onDeleted }: FieldEditorProps) {
  const { t } = useTranslation(['organize', 'common'])
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
    <form className="panel" onSubmit={submit} aria-label={field ? t('type.editLabel', { name: field.name }) : t('fields.new')}>
      <div className={styles.panelHead}>
        <h4>{field ? field.name : t('fields.new')}</h4>
        {field && !builtin && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(true)}>
            {t('field.delete')}
          </button>
        )}
      </div>

      <div className="field">
        <label htmlFor={`${id}-name`}>{t('type.name')}</label>
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
        <legend className="field-label">{t('field.kind')}</legend>
        <div className="seg">
          {FIELD_KINDS.map((kind) => (
            <label key={kind} className="seg-opt">
              <input
                type="radio"
                name={`${id}-kind`}
                value={kind}
                checked={draft.kind === kind}
                disabled={builtin}
                onChange={() => set({ kind })}
              />
              {kindLabel(kind)}
            </label>
          ))}
        </div>
        {hint('kind', builtin ? t('field.builtinKind') : undefined)}
      </fieldset>

      {draft.kind === 'choice' && (
        <div className="field">
          <label htmlFor={`${id}-options`}>{t('field.options')}</label>
          <TagInput
            id={`${id}-options`}
            value={options}
            onChange={(value) => set({ options: value })}
            listLabel={t('field.options')}
            itemLabel={t('field.option')}
            invalid={Boolean(errors.options)}
            describedBy={describedBy('options', true)}
          />
          {hint('options', t('field.optionsHint'))}
        </div>
      )}

      <div className="field">
        <div className={styles.labelRow}>
          <label htmlFor={`${id}-instructions`}>{t('type.identify')}</label>
          <HelpHint subject={t('field.ruleHintSubject')} title={t('field.ruleHintTitle')} article="write-a-rule">
            {t('field.ruleHint')}
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

      <Switch checked={draft.auto_fill ?? true} onChange={(autoFill) => set({ auto_fill: autoFill })}>
        {t('field.autoFill')}
      </Switch>

      {save.isError && !Object.keys(errors).length && (
        <p className="alert alert-error" role="alert">
          {errorMessage(save.error)}
        </p>
      )}

      <FieldTest test={test} />

      <div className={styles.actions}>
        <button type="submit" className="btn btn-primary" disabled={!canSave}>
          {save.isPending ? t('saving') : t('common:save')}
        </button>
        {/* Tests the draft as it is, without saving. */}
        <button
          type="button"
          className="btn btn-secondary"
          disabled={!complete || testing}
          onClick={() => test.run({ field: cleanDraft(draft) })}
        >
          {t('field.test')}
        </button>
      </div>

      {confirmDelete && field && (
        <DeleteFieldDialog field={field} onClose={() => setConfirmDelete(false)} onDeleted={onDeleted} />
      )}
    </form>
  )
}

function DeleteFieldDialog({ field, onClose, onDeleted }: { field: Field; onClose: () => void; onDeleted: () => void }) {
  const { t } = useTranslation('organize')
  const remove = useDeleteField()
  return (
    <Dialog
      plain
      title={t('deleteTitle', { name: field.name })}
      message={t('field.deleteText')}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            {t('keep')}
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={remove.isPending}
            // The list reloads before the mutate ends and unmounts this panel: the promise carries on anyway.
            onClick={() => remove.mutateAsync(field.id).then(onDeleted, () => {})}
          >
            {t('field.delete')}
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
