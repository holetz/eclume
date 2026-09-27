import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { api } from '../../api/client'
import { errorMessage, unwrap } from '../../api/problem'
import { usePageTitle } from '../../app/usePageTitle'
import styles from './CollectionsPage.module.css'
import { COLLECTIONS_KEY, useCollections, type Collection } from './queries'

interface CollectionFields {
  name: string
  description: string | null
}

export function CollectionsPage() {
  usePageTitle('Coleções')
  const collections = useCollections()
  const queryClient = useQueryClient()
  const [creating, setCreating] = useState(false)
  const create = useMutation({
    mutationFn: (fields: CollectionFields) => unwrap(api.POST('/api/v1/collections', { body: fields })),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: COLLECTIONS_KEY })
      setCreating(false)
    },
  })
  const items = collections.data?.items ?? []

  return (
    <section className={styles.page} aria-labelledby="colecoes-titulo">
      <header className={styles.header}>
        <div>
          <h1 id="colecoes-titulo">Coleções</h1>
          <p className="text-muted">Agrupe suas gravações por cliente, projeto ou programa. Uma gravação pode estar em várias.</p>
        </div>
        {!creating && (
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
            Nova coleção
          </button>
        )}
      </header>

      {creating && (
        <div className="card">
          <CollectionForm
            submitLabel="Criar coleção"
            pending={create.isPending}
            error={create.error}
            onSubmit={(fields) => create.mutate(fields)}
            onCancel={() => {
              create.reset()
              setCreating(false)
            }}
          />
        </div>
      )}

      {collections.isPending && <p role="status">Carregando coleções…</p>}
      {collections.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(collections.error)}
        </p>
      )}
      {collections.isSuccess && items.length === 0 && (
        <p className={`card ${styles.empty}`}>Nenhuma coleção ainda. Crie uma e escolha as gravações na página de cada uma.</p>
      )}
      {items.length > 0 && (
        <ul className={styles.list} aria-label="Coleções">
          {items.map((collection) => (
            <CollectionItem key={collection.id} collection={collection} />
          ))}
        </ul>
      )}
    </section>
  )
}

function CollectionItem({ collection }: { collection: Collection }) {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const path = { params: { path: { collection_id: collection.id } } }
  const invalidate = () => queryClient.invalidateQueries({ queryKey: COLLECTIONS_KEY })
  const save = useMutation({
    mutationFn: (fields: CollectionFields) =>
      unwrap(api.PATCH('/api/v1/collections/{collection_id}', { ...path, body: fields })),
    onSuccess: () => {
      invalidate()
      setEditing(false)
    },
  })
  const remove = useMutation({
    mutationFn: () => unwrap(api.DELETE('/api/v1/collections/{collection_id}', path)),
    onSuccess: () => {
      invalidate()
      queryClient.invalidateQueries({ queryKey: ['recordings'] })
    },
  })
  const count = collection.recording_count

  if (editing) {
    return (
      <li className="card">
        <CollectionForm
          initial={collection}
          submitLabel="Salvar"
          pending={save.isPending}
          error={save.error}
          onSubmit={(fields) => save.mutate(fields)}
          onCancel={() => {
            save.reset()
            setEditing(false)
          }}
        />
      </li>
    )
  }
  return (
    <li className={`card ${styles.item}`}>
      <div className={styles.info}>
        <h2 className={styles.name}>{collection.name}</h2>
        {collection.description && <p className="text-muted">{collection.description}</p>}
        <p className={styles.meta}>
          <span>{count === 1 ? '1 gravação' : `${count} gravações`}</span>
          <Link to={`/?colecao=${collection.id}`}>Ver gravações</Link>
        </p>
        {remove.isError && (
          <p className="alert alert-error" role="alert">
            {errorMessage(remove.error)}
          </p>
        )}
      </div>
      <div className={styles.actions}>
        {confirming ? (
          <>
            <button type="button" className="btn btn-danger btn-sm" onClick={() => remove.mutate()} disabled={remove.isPending}>
              Confirmar exclusão
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setConfirming(false)}>
              Manter
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setEditing(true)}
              aria-label={`Editar ${collection.name}`}
            >
              Editar
            </button>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              onClick={() => setConfirming(true)}
              aria-label={`Excluir ${collection.name}`}
            >
              Excluir
            </button>
          </>
        )}
      </div>
    </li>
  )
}

interface CollectionFormProps {
  initial?: CollectionFields
  submitLabel: string
  pending: boolean
  error: unknown
  onSubmit: (fields: CollectionFields) => void
  onCancel: () => void
}

function CollectionForm({ initial, submitLabel, pending, error, onSubmit, onCancel }: CollectionFormProps) {
  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const id = useId()

  function submit(event: FormEvent) {
    event.preventDefault()
    if (name.trim()) onSubmit({ name: name.trim(), description: description.trim() || null })
  }

  return (
    <form className={styles.form} onSubmit={submit}>
      <div className="field">
        <label htmlFor={`${id}-nome`}>Nome da coleção</label>
        <input id={`${id}-nome`} className="input" value={name} onChange={(e) => setName(e.target.value)} required />
      </div>
      <div className="field">
        <label htmlFor={`${id}-descricao`}>Descrição</label>
        <input id={`${id}-descricao`} className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      {error != null && (
        <p className="alert alert-error" role="alert">
          {errorMessage(error)}
        </p>
      )}
      <div className={styles.actions}>
        <button type="submit" className="btn btn-primary" disabled={pending || !name.trim()}>
          {submitLabel}
        </button>
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </form>
  )
}
