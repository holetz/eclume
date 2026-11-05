import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
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

// The placeholders every title pattern accepts; the user's fields come in through their key.
const BASE_MARKERS = ['{assunto}', '{data}', '{tipo}']

function draftOf(type: AgendaType | null): AgendaTypeDraft {
  if (!type) return EMPTY
  const { name, title_pattern, title_instructions, identify, default_tags, summary_instructions } = type
  return { name, title_pattern, title_instructions, identify, default_tags, summary_instructions }
}

/** The draft in the contract's shape: no spaces at the ends of the name, and an empty pattern becomes `null`. */
function cleanDraft(draft: AgendaTypeDraft): AgendaTypeDraft {
  return { ...draft, name: draft.name.trim(), title_pattern: draft.title_pattern?.trim() || null }
}

interface AgendaTypeEditorProps {
  /** The saved agenda type, or `null` for the draft of a new agenda type. */
  type: AgendaType | null
  onDirtyChange: (dirty: boolean) => void
  onSaved: (type: AgendaType) => void
  onDeleted: () => void
  /** A request from the summary chat, appended to the draft of the summary instructions, without saving. */
  summaryAddition?: string
}

export function AgendaTypeEditor({ type, onDirtyChange, onSaved, onDeleted, summaryAddition }: AgendaTypeEditorProps) {
  const { t } = useTranslation(['organize', 'common'])
  const id = useId()
  const initial = draftOf(type)
  const [draft, setDraft] = useState<AgendaTypeDraft>(() =>
    summaryAddition
      ? { ...initial, summary_instructions: `${initial.summary_instructions.trimEnd()}\n\n${summaryAddition}`.trimStart() }
      : initial,
  )
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [picking, setPicking] = useState(false)
  // The draft the on-screen preview used: editing after that invalidates it.
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
  // The fallback agenda type keeps the recording when no other one fits: it does not leave and does not compete.
  const fallback = type?.fallback === true
  const markers = [
    ...BASE_MARKERS,
    ...(fields.data?.items ?? []).filter((field) => !field.builtin).map((field) => `{${field.key}}`),
  ]

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange])

  const set = (changes: Partial<AgendaTypeDraft>) => setDraft((current) => ({ ...current, ...changes }))

  /** Inserts the placeholder at the cursor position of the title pattern and returns focus to it. */
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
    <form className="panel" onSubmit={submit} aria-label={type ? t('type.editLabel', { name: type.name }) : t('types.new')}>
      <div className={styles.panelHead}>
        <h4>
          {type ? type.name : t('types.new')}
          {fallback && <span className={`badge ${styles.badge}`}>{t('types.default')}</span>}
        </h4>
        {type && !fallback && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(true)}>
            {t('type.delete')}
          </button>
        )}
      </div>

      <div className={styles.pair}>
        <div className="field">
          <label htmlFor={`${id}-name`}>{t('type.name')}</label>
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
            <label htmlFor={`${id}-title`}>{t('type.recordingTitle')}</label>
            <HelpHint subject={t('type.titleHintSubject')} title={t('type.titleHintTitle')} article="padrao-de-titulo">
              {t('type.titleHint')}
            </HelpHint>
          </div>
          <input
            ref={titleInput}
            id={`${id}-title`}
            className={`input mono ${styles.mono}`}
            value={draft.title_pattern ?? ''}
            // i18n-ignore: the placeholders are the server pattern syntax, the same in every language
            placeholder="{tipo} · {assunto}"
            aria-invalid={invalid('title_pattern')}
            aria-describedby={errors.title_pattern ? `${id}-title_pattern-hint` : undefined}
            onChange={(event) => set({ title_pattern: event.target.value })}
          />
          {hint('title_pattern')}
        </div>
      </div>
      <div className={styles.markers} role="group" aria-label={t('type.markers')}>
        {markers.map((marker) => (
          <button
            key={marker}
            type="button"
            className={`tag tag-outline mono ${styles.marker}`}
            aria-label={t('type.insert', { marker })}
            onClick={() => insertMarker(marker)}
          >
            {marker}
          </button>
        ))}
      </div>

      <div className="field">
        <div className={styles.labelRow}>
          <label htmlFor={`${id}-title-rule`}>{t('type.subjectRule')}</label>
          <HelpHint subject={t('type.subjectHintSubject')} title={t('type.subjectHintTitle')} article="padrao-de-titulo">
            {t('type.subjectHint', { marker: '{assunto}' })}
          </HelpHint>
        </div>
        <textarea
          id={`${id}-title-rule`}
          className={`input ${styles.identify}`}
          value={draft.title_instructions ?? ''}
          placeholder={fallback ? undefined : t('type.subjectPlaceholder')}
          aria-invalid={invalid('title_instructions')}
          aria-describedby={`${id}-title_instructions-hint`}
          onChange={(event) => set({ title_instructions: event.target.value })}
        />
        {hint(
          'title_instructions',
          fallback ? t('type.subjectFallback') : t('type.subjectExample'),
        )}
      </div>

      {fallback ? (
        <p className={`field-hint ${styles.fallbackNote}`}>
          {t('type.fallbackNote')}
        </p>
      ) : (
        <div className="field">
          <label htmlFor={`${id}-identify`}>{t('type.identify')}</label>
          <textarea
            id={`${id}-identify`}
            className={`input ${styles.identify}`}
            value={draft.identify ?? ''}
            aria-invalid={invalid('identify')}
            aria-describedby={`${id}-identify-hint`}
            onChange={(event) => set({ identify: event.target.value })}
          />
          {hint('identify', t('type.identifyHint'))}
        </div>
      )}

      <div className="field">
        <label htmlFor={`${id}-tags`}>{t('type.tags')}</label>
        <TagInput
          id={`${id}-tags`}
          value={draft.default_tags ?? []}
          onChange={(value) => set({ default_tags: value })}
          listLabel={t('type.tags')}
          itemLabel="tag"
          invalid={Boolean(errors.default_tags)}
          describedBy={`${id}-default_tags-hint`}
        />
        {hint('default_tags', t('type.tagsHint'))}
      </div>

      <div className="field">
        <label htmlFor={`${id}-instructions`}>{t('type.instructions')}</label>
        <textarea
          id={`${id}-instructions`}
          className={`input mono ${styles.mono} ${styles.summaryInstructions}`}
          value={draft.summary_instructions}
          required
          aria-invalid={invalid('summary_instructions')}
          aria-describedby={`${id}-summary_instructions-hint`}
          onChange={(event) => set({ summary_instructions: event.target.value })}
        />
        {hint('summary_instructions', t('type.instructionsHint'))}
        {summaryAddition && (
          <p className="alert alert-info" role="status">
            {t('type.chatAdded')}
          </p>
        )}
      </div>

      {save.isError && !Object.keys(errors).length && (
        <p className="alert alert-error" role="alert">
          {errorMessage(save.error)}
        </p>
      )}

      <AgendaPreviewResult preview={preview} stale={previewedDraft !== null && previewedDraft !== draftKey} />

      <div className={styles.actions}>
        <button type="submit" className="btn btn-primary" disabled={!canSave}>
          {save.isPending ? t('saving') : t('common:save')}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={!complete || previewing}
          onClick={() => setPicking(true)}
        >
          {t('type.preview')}
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
  const { t } = useTranslation('organize')
  const remove = useDeleteAgendaType()
  return (
    <Dialog
      plain
      title={t('deleteTitle', { name: type.name })}
      message={t('type.deleteText')}
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
            onClick={() => remove.mutateAsync(type.id).then(onDeleted, () => {})}
          >
            {t('type.delete')}
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
