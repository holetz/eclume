import { useId, useState, type FormEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { errorMessage } from '../../api/problem'
import { TagInput } from '../organize/TagInput'
import styles from './People.module.css'
import { usePersonFacets } from './queries'

export interface PersonFields {
  name: string
  email: string | null
  notes: string | null
  company: string | null
  department: string | null
  job_title: string | null
  phone: string | null
  tags: string[]
}

interface PersonFormProps {
  initial: PersonFields
  pending: boolean
  error: unknown
  onSubmit: (fields: PersonFields) => void
  onCancel: () => void
  /** Destructive action on the left of the footer (Excluir pessoa). */
  danger?: ReactNode
}

type TextKey = Exclude<keyof PersonFields, 'tags'>

const TEXTS: { key: Exclude<TextKey, 'name' | 'notes'>; type?: string; suggest?: 'companies' | 'departments' }[] = [
  { key: 'company', suggest: 'companies' },
  { key: 'department', suggest: 'departments' },
  { key: 'job_title' },
  { key: 'email', type: 'email' },
  { key: 'phone', type: 'tel' },
]

/**
 * Editing of a person's record, in the "Editar" dialog: name, company, department, role, e-mail,
 * phone, person tags and notes. Company and department suggest the values already used; empty fields
 * become `null`.
 */
export function PersonForm({ initial, pending, error, onSubmit, onCancel, danger }: PersonFormProps) {
  const [draft, setDraft] = useState<Record<TextKey, string>>(() => ({
    name: initial.name,
    email: initial.email ?? '',
    notes: initial.notes ?? '',
    company: initial.company ?? '',
    department: initial.department ?? '',
    job_title: initial.job_title ?? '',
    phone: initial.phone ?? '',
  }))
  const { t } = useTranslation(['people', 'common'])
  const [tags, setTags] = useState(initial.tags)
  const facets = usePersonFacets()
  const id = useId()
  const set = (key: TextKey, value: string) => setDraft((current) => ({ ...current, [key]: value }))
  const orNull = (key: TextKey) => draft[key].trim() || null

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!draft.name.trim()) return
    onSubmit({
      name: draft.name.trim(),
      email: orNull('email'),
      notes: orNull('notes'),
      company: orNull('company'),
      department: orNull('department'),
      job_title: orNull('job_title'),
      phone: orNull('phone'),
      tags,
    })
  }

  return (
    <form className={styles.form} onSubmit={submit}>
      <div className="field">
        <label htmlFor={`${id}-name`}>{t('form.name')}</label>
        <input
          id={`${id}-name`}
          className="input"
          value={draft.name}
          onChange={(e) => set('name', e.target.value)}
          required
        />
      </div>
      <div className={styles.formGrid}>
        {TEXTS.map(({ key, type, suggest }) => (
          <div key={key} className="field">
            <label htmlFor={`${id}-${key}`}>{t(`column.${key}`)}</label>
            <input
              id={`${id}-${key}`}
              className="input"
              type={type ?? 'text'}
              value={draft[key]}
              list={suggest ? `${id}-${suggest}` : undefined}
              onChange={(e) => set(key, e.target.value)}
              autoComplete="off"
            />
            {suggest && (
              <datalist id={`${id}-${suggest}`}>
                {(facets.data?.[suggest] ?? []).map((item) => (
                  <option key={item.value} value={item.value} />
                ))}
              </datalist>
            )}
          </div>
        ))}
      </div>
      <div className="field">
        <label htmlFor={`${id}-tags`}>{t('form.tags')}</label>
        <TagInput
          id={`${id}-tags`}
          value={tags}
          onChange={setTags}
          listLabel={t('form.tags')}
          itemLabel="tag"
          describedBy={`${id}-tags-hint`}
        />
        <span id={`${id}-tags-hint`} className="field-hint">
          {t('form.tagsHint')}
        </span>
      </div>
      <div className="field">
        <label htmlFor={`${id}-notes`}>{t('form.notes')}</label>
        <textarea id={`${id}-notes`} className="input" value={draft.notes} onChange={(e) => set('notes', e.target.value)} />
      </div>
      {error != null && (
        <p className="alert alert-error" role="alert">
          {errorMessage(error)}
        </p>
      )}
      <div className="dialog-actions">
        {danger}
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          {t('common:cancel')}
        </button>
        <button type="submit" className="btn btn-primary" disabled={pending || !draft.name.trim()}>
          {t('common:save')}
        </button>
      </div>
    </form>
  )
}
