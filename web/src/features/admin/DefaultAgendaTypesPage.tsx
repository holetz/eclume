import { X } from 'lucide-react'
import { useEffect, useId, useState, type FormEvent, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { Schemas } from '../../api/client'
import { ApiError, errorMessage } from '../../api/problem'
import { ConfirmDialog } from '../../app/ConfirmDialog'
import { AdminPageHead } from './AdminPageHead'
import styles from './Admin.module.css'
import { fieldErrorsOf, summaryOf } from './labels'
import {
  useDefaultAgendaTypes,
  useDeleteDefaultAgendaType,
  useSaveDefaultAgendaType,
  useToggleDefaultAgendaType,
} from './queries'
import { Switch } from '../../shared/Switch'
import { activeLocale, i18n } from '../../i18n'

type AgendaType = Schemas['DefaultAgendaType']
type Draft = Pick<
  AgendaType,
  'name' | 'title_pattern' | 'title_instructions' | 'identify' | 'default_tags' | 'summary_instructions'
> & {
  include_for_new_users: boolean
}

const NEW = 'novo'
const EMPTY: Draft = {
  name: '',
  title_pattern: null,
  title_instructions: '',
  identify: '',
  default_tags: [],
  summary_instructions: '',
  include_for_new_users: true,
}

function draftOf(type: AgendaType): Draft {
  const { name, title_pattern, title_instructions, identify, default_tags, summary_instructions, include_for_new_users } =
    type
  return { name, title_pattern, title_instructions, identify, default_tags, summary_instructions, include_for_new_users }
}

/** What changed in the draft, so the PATCH sends only that. */
function changesOf(draft: Draft, saved: Draft): Partial<Draft> {
  return Object.fromEntries(
    (Object.keys(draft) as (keyof Draft)[])
      .filter((key) => JSON.stringify(draft[key]) !== JSON.stringify(saved[key]))
      .map((key) => [key, draft[key]]),
  )
}

/** The initial set of agenda types, copied to each new account. */
export function DefaultAgendaTypesPage() {
  const { t } = useTranslation('admin')
  const types = useDefaultAgendaTypes()
  const toggle = useToggleDefaultAgendaType()
  const [selected, setSelected] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [leavingTo, setLeavingTo] = useState<string | null>(null)
  const items = types.data ?? []
  // With no choice (or with the chosen one deleted), opens the first, as in the DS.
  const current = selected === NEW ? null : (items.find((type) => type.id === selected) ?? items[0] ?? null)
  const openId = selected === NEW ? NEW : (current?.id ?? null)

  function open(target: string) {
    if (target === openId) return
    if (dirty) setLeavingTo(target)
    else setSelected(target)
  }

  function discard() {
    setDirty(false)
    setSelected(leavingTo)
    setLeavingTo(null)
  }

  return (
    <>
      <AdminPageHead
        title={t('agendaTypes.title')}
        actions={
          <button type="button" className="btn btn-primary" onClick={() => open(NEW)}>
            {t('agendaTypes.new')}
          </button>
        }
      />
      <p className={`text-muted ${styles.lede}`}>
        {t('agendaTypes.lede')}
      </p>
      {types.isPending && <p role="status">{t('agendaTypes.loading')}</p>}
      {types.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(types.error)}
        </p>
      )}
      {toggle.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(toggle.error)}
        </p>
      )}
      {types.isSuccess && (
        <div className={`split ${styles.split}`}>
          <div>
            {items.length === 0 ? (
              <p className="text-muted">{t('agendaTypes.none')}</p>
            ) : (
              <div className="list" role="list" aria-label={t('agendaTypes.title')}>
                {items.map((type) => (
                  <div
                    key={type.id}
                    role="listitem"
                    className={`list-row ${styles.typeRow}`}
                    aria-current={type.id === openId ? 'true' : undefined}
                    onClick={() => open(type.id)}
                  >
                    <button type="button" className={`list-row-title ${styles.rowButton}`}>
                      {type.name}
                    </button>
                    <span className="list-row-sub">{t('agendaTypes.summary', { summary: summaryOf(type.summary_instructions) })}</span>
                    <span className="list-row-actions" onClick={(e) => e.stopPropagation()}>
                      <Switch
                        checked={type.include_for_new_users}
                        onChange={(include) => toggle.mutate({ id: type.id, include })}
                        label={t('agendaTypes.includeName', { name: type.name })}
                      />
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
          {openId !== null && (
            <TypePanel
              key={openId}
              type={current}
              onDirty={setDirty}
              onSaved={(id) => {
                setDirty(false)
                setSelected(id)
              }}
              onDeleted={() => {
                setDirty(false)
                setSelected(null)
              }}
            />
          )}
        </div>
      )}
      {leavingTo !== null && (
        <ConfirmDialog
          title={t('agendaTypes.discardTitle', { name: current?.name ?? t('agendaTypes.new') })}
          confirmLabel={t('agendaTypes.discard')}
          onConfirm={discard}
          onCancel={() => setLeavingTo(null)}
        />
      )}
    </>
  )
}

interface TypePanelProps {
  type: AgendaType | null
  onDirty: (dirty: boolean) => void
  onSaved: (id: string) => void
  onDeleted: () => void
}

function TypePanel({ type, onDirty, onSaved, onDeleted }: TypePanelProps) {
  const { t } = useTranslation('admin')
  const save = useSaveDefaultAgendaType()
  const toggle = useToggleDefaultAgendaType()
  const remove = useDeleteDefaultAgendaType()
  const saved = type ? draftOf(type) : EMPTY
  const [draft, setDraft] = useState<Draft>(saved)
  const [tag, setTag] = useState('')
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const ids = {
    name: useId(),
    title: useId(),
    titleRule: useId(),
    identify: useId(),
    tags: useId(),
    instructions: useId(),
  }
  // When editing, "Incluir" saves at once, as in the list; for a new type, it goes in the POST.
  const effective = type ? { ...draft, include_for_new_users: type.include_for_new_users } : draft
  const changes = changesOf(effective, saved)
  const changed = Object.keys(changes).length > 0
  const nameError = nameErrorOf(save.error)

  useEffect(() => onDirty(changed), [changed, onDirty])

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => ({ ...current, [key]: value }))

  function addTag() {
    const value = tag.trim().toLocaleLowerCase(activeLocale())
    if (value && !draft.default_tags.includes(value)) set('default_tags', [...draft.default_tags, value])
    setTag('')
  }

  function onTagKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault()
      addTag()
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!changed || !draft.name.trim() || !draft.summary_instructions.trim()) return
    const body = type
      ? changes
      : { ...draft, name: draft.name.trim(), title_pattern: draft.title_pattern?.trim() || null }
    save.mutate({ id: type?.id ?? null, body }, { onSuccess: (result) => onSaved(result.id) })
  }

  const title = type?.name ?? t('agendaTypes.new')
  return (
    <form className={`panel ${styles.typePanel}`} onSubmit={submit} aria-label={title}>
      <div className={styles.panelHead}>
        <h4>{title}</h4>
        <div className={styles.row}>
          <Switch
            checked={effective.include_for_new_users}
            onChange={(include) =>
              type ? toggle.mutate({ id: type.id, include }) : set('include_for_new_users', include)
            }
          >
            <span className={styles.small}>{t('agendaTypes.include')}</span>
          </Switch>
          {type && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmingDelete(true)}>
              {t('agendaTypes.delete')}
            </button>
          )}
        </div>
      </div>
      <div className={styles.twoCols}>
        <div className="field">
          <label htmlFor={ids.name}>{t('agendaTypes.name')}</label>
          <input
            id={ids.name}
            className="input"
            required
            maxLength={120}
            value={draft.name}
            aria-invalid={nameError ? true : undefined}
            aria-describedby={nameError ? `${ids.name}-erro` : undefined}
            onChange={(e) => set('name', e.target.value)}
          />
          {nameError && (
            <span id={`${ids.name}-erro`} className={`field-hint ${styles.error}`}>
              {nameError}
            </span>
          )}
        </div>
        <div className="field">
          <label htmlFor={ids.title}>{t('agendaTypes.recordingTitle')}</label>
          <input
            id={ids.title}
            className={`input mono ${styles.monoInput}`}
            maxLength={300}
            value={draft.title_pattern ?? ''}
            aria-describedby={`${ids.title}-dica`}
            onChange={(e) => set('title_pattern', e.target.value || null)}
          />
          <span id={`${ids.title}-dica`} className="field-hint">
            {t('agendaTypes.titleHint', { placeholders: '{assunto}, {data}, {tipo}' })}
          </span>
        </div>
      </div>
      <div className="field">
        <label htmlFor={ids.titleRule}>{t('agendaTypes.titleRule')}</label>
        <textarea
          id={ids.titleRule}
          className={`input ${styles.identify}`}
          maxLength={4000}
          value={draft.title_instructions}
          aria-describedby={`${ids.titleRule}-dica`}
          onChange={(e) => set('title_instructions', e.target.value)}
        />
        <span id={`${ids.titleRule}-dica`} className="field-hint">
          {t('agendaTypes.titleRuleHint', { subject: '{assunto}' })}
        </span>
      </div>
      <div className="field">
        <label htmlFor={ids.identify}>{t('agendaTypes.identify')}</label>
        <textarea
          id={ids.identify}
          className={`input ${styles.identify}`}
          maxLength={4000}
          value={draft.identify}
          aria-describedby={`${ids.identify}-dica`}
          onChange={(e) => set('identify', e.target.value)}
        />
        <span id={`${ids.identify}-dica`} className="field-hint">
          {t('agendaTypes.identifyHint')}
        </span>
      </div>
      <div className="field" role="group" aria-labelledby={ids.tags}>
        <span id={ids.tags} className={styles.label}>
          {t('agendaTypes.tags')}
        </span>
        <div className={styles.row}>
          {draft.default_tags.map((value) => (
            <span key={value} className="tag">
              {value}
              <button
                type="button"
                className={styles.tagRemove}
                aria-label={t('agendaTypes.removeTag', { tag: value })}
                onClick={() => set('default_tags', draft.default_tags.filter((item) => item !== value))}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </span>
          ))}
          <input
            className={`input ${styles.tagInput}`}
            aria-label={t('agendaTypes.addTag')}
            placeholder={t('agendaTypes.addTag')}
            maxLength={64}
            value={tag}
            disabled={draft.default_tags.length >= 20}
            onChange={(e) => setTag(e.target.value)}
            onKeyDown={onTagKey}
            onBlur={addTag}
          />
        </div>
      </div>
      <div className="field">
        <label htmlFor={ids.instructions}>{t('agendaTypes.instructions')}</label>
        <textarea
          id={ids.instructions}
          className={`input mono ${styles.instructionsInput}`}
          required
          maxLength={4000}
          value={draft.summary_instructions}
          onChange={(e) => set('summary_instructions', e.target.value)}
        />
      </div>
      {save.isError && !nameError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(save.error)}
        </p>
      )}
      {(toggle.isError || remove.isError) && (
        <p className="alert alert-error" role="alert">
          {errorMessage(toggle.error ?? remove.error)}
        </p>
      )}
      <div className={styles.row}>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={!changed || save.isPending || !draft.name.trim() || !draft.summary_instructions.trim()}
        >
          {save.isPending ? t('settings.saving') : t('settings.save')}
        </button>
        <span className={`text-muted ${styles.small}`}>{t('agendaTypes.appliesLater')}</span>
      </div>
      {confirmingDelete && type && (
        <ConfirmDialog
          title={t('agendaTypes.deleteTitle', { name: type.name })}
          confirmLabel={t('agendaTypes.delete')}
          busy={remove.isPending}
          onConfirm={() => remove.mutate(type.id, { onSuccess: onDeleted })}
          onCancel={() => setConfirmingDelete(false)}
        >
          {t('agendaTypes.deleteBody')}
        </ConfirmDialog>
      )}
    </form>
  )
}

/** A repeated name (409) or a refused one (422 on `name`) shows on the Nome field. */
function nameErrorOf(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null
  if (error.status === 409) return i18n.t('admin:agendaTypes.duplicate')
  return fieldErrorsOf(error).name ?? null
}
