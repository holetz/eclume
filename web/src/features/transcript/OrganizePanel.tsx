import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { api, type Schemas } from '../../api/client'
import { errorMessage, unwrap } from '../../api/problem'
import { useMe } from '../../app/session'
import { COLLECTIONS_KEY, TAGS_KEY, useCollections } from '../collections/queries'
import { MEETING_TYPES, METADATA_FIELDS, mergeMetadata, parseTags, type MetadataKey } from './organize'
import styles from './OrganizePanel.module.css'
import { recordingKey } from './queries'

type Recording = Schemas['Recording']

/** Tags, coleções e metadados da gravação: o dono edita, quem vê por compartilhamento só lê. */
export function OrganizePanel({ recording }: { recording: Recording }) {
  const me = useMe()
  const titleId = useId()
  // Fora do formulário: salvar troca o `updated_at` e remonta o formulário com os valores novos.
  const [notice, setNotice] = useState('')
  const isOwner = me.data?.user.id === recording.owner.id
  return (
    <section className={`card ${styles.panel}`} aria-labelledby={titleId}>
      <h2 id={titleId}>Organização</h2>
      {isOwner ? (
        <OrganizeForm key={recording.updated_at} recording={recording} onSaved={setNotice} />
      ) : (
        <OrganizeSummary recording={recording} />
      )}
      <p className="visually-hidden" role="status">
        {notice}
      </p>
    </section>
  )
}

function OrganizeSummary({ recording }: { recording: Recording }) {
  const fields = METADATA_FIELDS.filter(({ key }) => recording.metadata[key])
  if (recording.tags.length === 0 && fields.length === 0) return <p className="muted">Sem tags nem metadados.</p>
  return (
    <dl className={styles.summary}>
      {recording.tags.length > 0 && (
        <div>
          <dt>Tags</dt>
          <dd>{recording.tags.join(', ')}</dd>
        </div>
      )}
      {fields.map(({ key, label }) => (
        <div key={key}>
          <dt>{label}</dt>
          <dd>{recording.metadata[key]}</dd>
        </div>
      ))}
    </dl>
  )
}

function OrganizeForm({ recording, onSaved }: { recording: Recording; onSaved: (notice: string) => void }) {
  const queryClient = useQueryClient()
  const collections = useCollections()
  const id = useId()
  const [tags, setTags] = useState(recording.tags.join(', '))
  const [chosen, setChosen] = useState<string[]>(recording.collection_ids)
  const [metadata, setMetadata] = useState<Record<MetadataKey, string>>(() => ({
    tipo_reuniao: recording.metadata.tipo_reuniao ?? '',
    cliente: recording.metadata.cliente ?? '',
    projeto: recording.metadata.projeto ?? '',
  }))
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.PATCH('/api/v1/recordings/{recording_id}', {
          params: { path: { recording_id: recording.id } },
          body: {
            tags: parseTags(tags),
            collection_ids: chosen,
            metadata: mergeMetadata(recording.metadata, metadata),
          },
        }),
      ),
    onSuccess: (updated) => {
      queryClient.setQueryData(recordingKey(recording.id), updated)
      for (const key of [COLLECTIONS_KEY, TAGS_KEY, ['recordings']]) queryClient.invalidateQueries({ queryKey: key })
      onSaved('Organização salva.')
    },
  })

  function submit(event: FormEvent) {
    event.preventDefault()
    onSaved('')
    save.mutate()
  }

  function toggle(collectionId: string, checked: boolean) {
    setChosen((current) => (checked ? [...current, collectionId] : current.filter((c) => c !== collectionId)))
  }

  return (
    <form className={styles.form} onSubmit={submit}>
      <div className="field">
        <label htmlFor={`${id}-tags`}>Tags</label>
        <input id={`${id}-tags`} className="input" value={tags} onChange={(e) => setTags(e.target.value)} aria-describedby={`${id}-tags-dica`} />
        <span id={`${id}-tags-dica`} className="hint">
          Separadas por vírgula.
        </span>
      </div>
      {METADATA_FIELDS.map(({ key, label }) => (
        <div key={key} className="field">
          <label htmlFor={`${id}-${key}`}>{label}</label>
          <input
            id={`${id}-${key}`}
            className="input"
            value={metadata[key]}
            list={key === 'tipo_reuniao' ? `${id}-tipos` : undefined}
            onChange={(e) => setMetadata((current) => ({ ...current, [key]: e.target.value }))}
          />
        </div>
      ))}
      <datalist id={`${id}-tipos`}>
        {MEETING_TYPES.map((type) => (
          <option key={type} value={type} />
        ))}
      </datalist>
      <fieldset className={styles.collections}>
        <legend className="label">Coleções</legend>
        {collections.data?.items.length === 0 && (
          <p className={styles.hint}>
            Nenhuma coleção. <Link to="/colecoes">Criar uma</Link>.
          </p>
        )}
        {collections.data?.items.map((collection) => (
          <label key={collection.id} className={styles.check}>
            <input
              type="checkbox"
              checked={chosen.includes(collection.id)}
              onChange={(e) => toggle(collection.id, e.target.checked)}
            />
            {collection.name}
          </label>
        ))}
      </fieldset>
      {save.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(save.error)}
        </p>
      )}
      <button type="submit" className="btn btn-primary btn-sm" disabled={save.isPending}>
        Salvar organização
      </button>
    </form>
  )
}
