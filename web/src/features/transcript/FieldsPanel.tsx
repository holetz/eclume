import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, useState, type FormEvent, type ReactNode } from 'react'
import { api, type Schemas } from '../../api/client'
import { errorMessage, unwrap } from '../../api/problem'
import { COLLECTIONS_KEY, useCollections } from '../collections/queries'
import { parseTags, sortFields, useFieldMutations, useRecordingFields, type FieldValue } from './fields'
import { recordingKey } from './queries'
import styles from './RecordingPage.module.css'
import { speakerColorIndex, speakerName, type Transcript } from './segments'

type Recording = Schemas['Recording']

const MAX_TEXT = 300

const METADATA_LABELS: Record<string, string> = {
  tipo_reuniao: 'Tipo de reunião',
  cliente: 'Cliente',
  projeto: 'Projeto',
}

function Origin({ origin }: { origin: 'auto' | 'edited' | 'accepted' | null }) {
  if (origin === 'auto') return <span className="origin">Automático</span>
  if (origin === 'edited') return <span className="origin origin-edited">Editado</span>
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
  const { value } = item
  if (value === null || (Array.isArray(value) && value.length === 0)) {
    return <span className="text-muted">Nada encontrado</span>
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

/** O valor do campo em edição, pelo tipo: texto, lista separada por vírgula ou escolha. */
function draftOf(item: FieldValue): string {
  if (Array.isArray(item.value)) return item.value.join(', ')
  return item.value ?? ''
}

function FieldProp({ item, recordingId }: { item: FieldValue; recordingId: string }) {
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
              <option value="">Nenhum</option>
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
              placeholder={field.kind === 'list' ? 'Separe por vírgula' : undefined}
              autoFocus
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setDraft(null)
              }}
            />
          )}
          <span className={styles.propFormActions}>
            <button type="submit" className="btn btn-primary btn-sm" disabled={put.isPending}>
              Salvar
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDraft(null)}>
              Cancelar
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
              aria-label={`Aceitar ${field.name}`}
              disabled={accept.isPending}
              onClick={() => accept.mutate(field)}
            >
              Aceitar
            </button>
          )}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-label={`Editar ${field.name}`}
            onClick={() => setDraft(draftOf(item))}
          >
            Editar
          </button>
        </>
      }
    >
      <Value item={item} />
      <Origin origin={item.origin} />
    </Prop>
  )
}

function CollectionsProp({ recording }: { recording: Recording }) {
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
      <Prop label="Coleções">
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
              Nova coleção
            </label>
            <input
              id={newId}
              className="input"
              placeholder="Nova coleção…"
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
              Criar
            </button>
          </span>
          <span className={styles.propFormActions}>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={save.isPending}
              onClick={() => save.mutate(chosen)}
            >
              Salvar
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setChosen(null)}>
              Cancelar
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
      label="Coleções"
      actions={
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          aria-label="Editar Coleções"
          onClick={() => setChosen(recording.collection_ids)}
        >
          Editar
        </button>
      }
    >
      {recording.collection_ids.length === 0 ? (
        <span className="text-muted">Nenhuma</span>
      ) : (
        recording.collection_ids.map((id) => (
          <span key={id} className="tag tag-neutral">
            {byId.get(id) ?? 'Coleção'}
          </span>
        ))
      )}
    </Prop>
  )
}

interface FieldsPanelProps {
  recording: Recording
  transcript: Transcript | undefined
  onChangeType: () => void
  onFixSpeakers: () => void
}

/**
 * O painel de campos (componente "Filled fields", variante A): o valor de cada campo com o selo de
 * origem, Aceitar e Editar; o tipo de agenda com Trocar; coleções; locutores; e os dados antigos.
 */
export function FieldsPanel({ recording, transcript, onChangeType, onFixSpeakers }: FieldsPanelProps) {
  const fields = useRecordingFields(recording.id)
  const { acceptAll } = useFieldMutations(recording.id)
  const titleId = useId()
  const items = sortFields(fields.data?.items ?? [])
  const anyAuto = items.some((item) => item.origin === 'auto')
  const metadata = Object.entries(recording.metadata ?? {}).filter(([, value]) => value)

  return (
    <section className={styles.fields} aria-labelledby={titleId}>
      <div className={styles.fieldsHead}>
        <h6 id={titleId}>Campos</h6>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={!anyAuto || acceptAll.isPending}
          onClick={() => acceptAll.mutate()}
        >
          Aceitar tudo
        </button>
      </div>
      {fields.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(fields.error)}
        </p>
      )}
      <div className={`props ${styles.props}`}>
        {items.map((item) => (
          <FieldProp key={item.field.id} item={item} recordingId={recording.id} />
        ))}
        <Prop
          label="Tipo de agenda"
          actions={
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-label="Trocar o tipo de agenda"
              onClick={onChangeType}
            >
              Trocar
            </button>
          }
        >
          {recording.agenda_type ? (
            <>
              <span>{recording.agenda_type.name}</span>
              <Origin origin={recording.agenda_type.origin} />
            </>
          ) : (
            <span className="text-muted">Nenhum</span>
          )}
        </Prop>
        <CollectionsProp recording={recording} />
        {transcript && (
          <Prop label="Locutores">
            <span className={styles.speakers}>
              {transcript.speakers.map((speaker) => (
                <span
                  key={speaker.id}
                  className={`speaker speaker-${speakerColorIndex(transcript.speakers, speaker.id)}`}
                >
                  {speakerName(speaker)}
                </span>
              ))}
              <button type="button" className={`btn btn-ghost btn-sm ${styles.fixSpeakers}`} onClick={onFixSpeakers}>
                Corrigir locutores
              </button>
            </span>
          </Prop>
        )}
        {metadata.length > 0 && (
          <Prop label="Dados anteriores">
            <span className={styles.legacy}>
              {metadata.map(([key, value]) => (
                <span key={key}>
                  {METADATA_LABELS[key] ?? key}: {value}
                </span>
              ))}
              <span className="text-muted">
                Da organização antiga; crie um campo em Campos e regras para usar de novo.
              </span>
            </span>
          </Prop>
        )}
      </div>
    </section>
  )
}
