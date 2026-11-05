import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, useState, type FormEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { api, type Schemas } from '../../api/client'
import { errorMessage, unwrap } from '../../api/problem'
import { COLLECTIONS_KEY, useCollections } from '../collections/queries'
import { parseTags, sortFields, useFieldMutations, useRecordingFields, type FieldValue } from './fields'
import { recordingKey } from './queries'
import styles from './RecordingPage.module.css'

type Recording = Schemas['Recording']

const MAX_TEXT = 300

const METADATA_KEYS = ['tipo_reuniao', 'cliente', 'projeto'] as const
type MetadataKey = (typeof METADATA_KEYS)[number]
const isMetadataKey = (key: string): key is MetadataKey => (METADATA_KEYS as readonly string[]).includes(key)

function Origin({ origin }: { origin: 'auto' | 'edited' | 'accepted' | null }) {
  const { t } = useTranslation('transcript')
  if (origin === 'auto') return <span className="origin">{t('fields.auto')}</span>
  if (origin === 'edited') return <span className="origin origin-edited">{t('fields.edited')}</span>
  return null
}

function Prop({ label, children, actions }: { label: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="prop" role="group" aria-label={label}>
      <span className="prop-label">{label}</span>
      <span className="prop-value">{children}</span>
      {actions && <span className="prop-actions">{actions}</span>}
    </div>
  )
}

function Value({ item }: { item: FieldValue }) {
  const { t } = useTranslation('transcript')
  const { value } = item
  if (value === null || (Array.isArray(value) && value.length === 0)) {
    return <span className="text-muted">{t('fields.nothing')}</span>
  }
  if (Array.isArray(value)) {
    return value.map((tag) => (
      <span key={tag} className="tag tag-accent">
        {tag}
      </span>
    ))
  }
  return <span>{value}</span>
}

/** The value of the field being edited, by type: text, comma-separated list or choice. */
function draftOf(item: FieldValue): string {
  if (Array.isArray(item.value)) return item.value.join(', ')
  return item.value ?? ''
}

/**
 * Where the field's rule is edited: the custom field in Campos personalizados; the built-ins lead
 * to the owner, the title to the recording's agenda type and the tags to Tags.
 */
function ruleLink(field: FieldValue['field'], agendaTypeId: string | undefined): string {
  if (field.builtin === 'tags') return '/tags'
  if (field.builtin === 'title') return agendaTypeId ? `/config/agendas?tipo=${agendaTypeId}` : '/config/agendas'
  return `/config/campos?campo=${field.id}`
}

function FieldProp({ item, recording }: { item: FieldValue; recording: Recording }) {
  const recordingId = recording.id
  const { t } = useTranslation(['transcript', 'common'])
  const { put, accept } = useFieldMutations(recordingId)
  const [draft, setDraft] = useState<string | null>(null)
  const inputId = useId()
  const { field } = item

  function save(event: FormEvent) {
    event.preventDefault()
    const text = (draft ?? '').trim()
    const value = field.kind === 'list' ? parseTags(text) : text
    put.mutate(
      { field, value: (Array.isArray(value) ? value.length === 0 : !value) ? null : value },
      { onSuccess: () => setDraft(null) },
    )
  }

  if (draft !== null) {
    return (
      <Prop label={field.name}>
        <form className={styles.propForm} onSubmit={save}>
          <label htmlFor={inputId} className="visually-hidden">
            {field.name}
          </label>
          {field.kind === 'choice' ? (
            <select id={inputId} className="input" value={draft} onChange={(event) => setDraft(event.target.value)}>
              <option value="">{t('fields.noneM')}</option>
              {field.options.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          ) : (
            <input
              id={inputId}
              className="input"
              value={draft}
              maxLength={field.kind === 'text' ? MAX_TEXT : undefined}
              placeholder={field.kind === 'list' ? t('fields.commaHint') : undefined}
              autoFocus
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setDraft(null)
              }}
            />
          )}
          <span className={styles.propFormActions}>
            <button type="submit" className="btn btn-primary btn-sm" disabled={put.isPending}>
              {t('common:save')}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDraft(null)}>
              {t('common:cancel')}
            </button>
          </span>
          {put.isError && (
            <span className="alert alert-error" role="alert">
              {errorMessage(put.error)}
            </span>
          )}
        </form>
      </Prop>
    )
  }

  return (
    <Prop
      label={field.name}
      actions={
        <>
          {item.origin === 'auto' && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-label={t('fields.acceptLabel', { name: field.name })}
              disabled={accept.isPending}
              onClick={() => accept.mutate(field)}
            >
              {t('fields.accept')}
            </button>
          )}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-label={t('fields.editLabel', { name: field.name })}
            onClick={() => setDraft(draftOf(item))}
          >
            {t('fields.edit')}
          </button>
          <Link
            to={ruleLink(field, recording.agenda_type?.id)}
            className="btn btn-ghost btn-sm"
            aria-label={t('fields.ruleLabel', { name: field.name })}
          >
            {t('fields.rule')}
          </Link>
        </>
      }
    >
      <Value item={item} />
      <Origin origin={item.origin} />
    </Prop>
  )
}

function CollectionsProp({ recording }: { recording: Recording }) {
  const { t } = useTranslation(['transcript', 'common'])
  const queryClient = useQueryClient()
  const collections = useCollections()
  const [chosen, setChosen] = useState<string[] | null>(null)
  const [newName, setNewName] = useState('')
  const newId = useId()
  const byId = new Map(collections.data?.items.map((collection) => [collection.id, collection.name]))
  const save = useMutation({
    mutationFn: (ids: string[]) =>
      unwrap(
        api.PATCH('/api/v1/recordings/{recording_id}', {
          params: { path: { recording_id: recording.id } },
          body: { collection_ids: ids },
        }),
      ),
    onSuccess: (updated) => {
      queryClient.setQueryData(recordingKey(recording.id), updated)
      void queryClient.invalidateQueries({ queryKey: COLLECTIONS_KEY })
      void queryClient.invalidateQueries({ queryKey: ['recordings'] })
      setChosen(null)
    },
  })
  const create = useMutation({
    mutationFn: (name: string) => unwrap(api.POST('/api/v1/collections', { body: { name } })),
    onSuccess: (collection) => {
      void queryClient.invalidateQueries({ queryKey: COLLECTIONS_KEY })
      setChosen((current) => [...(current ?? []), collection.id])
      setNewName('')
    },
  })

  if (chosen !== null) {
    return (
      <Prop label={t('fields.collections')}>
        <div className={styles.propForm}>
          {collections.data?.items.map((collection) => (
            <label key={collection.id} className="check">
              <input
                type="checkbox"
                checked={chosen.includes(collection.id)}
                onChange={() =>
                  setChosen(
                    chosen.includes(collection.id)
                      ? chosen.filter((id) => id !== collection.id)
                      : [...chosen, collection.id],
                  )
                }
              />
              <span className="box" />
              <span>{collection.name}</span>
            </label>
          ))}
          <span className={styles.propFormActions}>
            <label htmlFor={newId} className="visually-hidden">
              {t('fields.newCollection')}
            </label>
            <input
              id={newId}
              className="input"
              placeholder={t('fields.newCollectionPlaceholder')}
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && newName.trim()) {
                  event.preventDefault()
                  create.mutate(newName.trim())
                }
              }}
            />
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={!newName.trim() || create.isPending}
              onClick={() => create.mutate(newName.trim())}
            >
              {t('fields.create')}
            </button>
          </span>
          <span className={styles.propFormActions}>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={save.isPending}
              onClick={() => save.mutate(chosen)}
            >
              {t('common:save')}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setChosen(null)}>
              {t('common:cancel')}
            </button>
          </span>
          {(save.isError || create.isError) && (
            <span className="alert alert-error" role="alert">
              {errorMessage(save.error ?? create.error)}
            </span>
          )}
        </div>
      </Prop>
    )
  }

  return (
    <Prop
      label={t('fields.collections')}
      actions={
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          aria-label={t('fields.editLabel', { name: t('fields.collections') })}
          onClick={() => setChosen(recording.collection_ids)}
        >
          {t('fields.edit')}
        </button>
      }
    >
      {recording.collection_ids.length === 0 ? (
        <span className="text-muted">{t('fields.noneF')}</span>
      ) : (
        recording.collection_ids.map((id) => (
          <span key={id} className="tag tag-neutral">
            {byId.get(id) ?? t('fields.collection')}
          </span>
        ))
      )}
    </Prop>
  )
}

interface FieldsPanelProps {
  recording: Recording
  onChangeType: () => void
}

/**
 * The fields panel (component "Filled fields", variant A): each field's value with the origin
 * badge, Aceitar and Editar; the agenda type with Trocar; collections; and the legacy data. The speakers
 * stay in their own block, above the transcript.
 */
export function FieldsPanel({ recording, onChangeType }: FieldsPanelProps) {
  const { t } = useTranslation('transcript')
  const fields = useRecordingFields(recording.id)
  const { acceptAll } = useFieldMutations(recording.id)
  const titleId = useId()
  const items = sortFields(fields.data?.items ?? [])
  const anyAuto = items.some((item) => item.origin === 'auto')
  const metadata = Object.entries(recording.metadata ?? {}).filter(([, value]) => value)

  return (
    <section className={styles.fields} aria-labelledby={titleId}>
      <div className={styles.fieldsHead}>
        <h6 id={titleId}>{t('fields.title')}</h6>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={!anyAuto || acceptAll.isPending}
          onClick={() => acceptAll.mutate()}
        >
          {t('fields.acceptAll')}
        </button>
      </div>
      {fields.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(fields.error)}
        </p>
      )}
      <div className={`props ${styles.props}`}>
        {items.map((item) => (
          <FieldProp key={item.field.id} item={item} recording={recording} />
        ))}
        <Prop
          label={t('fields.agendaType')}
          actions={
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-label={t('fields.changeTypeLabel')}
              onClick={onChangeType}
            >
              {t('fields.change')}
            </button>
          }
        >
          {recording.agenda_type ? (
            <>
              <span>{recording.agenda_type.name}</span>
              <Origin origin={recording.agenda_type.origin} />
            </>
          ) : (
            <span className="text-muted">{t('fields.noneM')}</span>
          )}
        </Prop>
        <CollectionsProp recording={recording} />
        {metadata.length > 0 && (
          <Prop label={t('fields.legacy')}>
            <span className={styles.legacy}>
              {metadata.map(([key, value]) => (
                <span key={key}>
                  {isMetadataKey(key) ? t(`fields.meta.${key}`) : key}: {value}
                </span>
              ))}
              <span className="text-muted">{t('fields.legacyHint')}</span>
            </span>
          </Prop>
        )}
      </div>
    </section>
  )
}
