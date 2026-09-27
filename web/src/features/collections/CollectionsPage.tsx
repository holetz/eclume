import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { api } from '../../api/client'
import { errorMessage, unwrap } from '../../api/problem'
import { Dialog } from '../../app/Dialog'
import { useHelpTopic } from '../../app/help'
import { PageHead } from '../../app/PageHead'
import styles from './CollectionsPage.module.css'
import { COLLECTIONS_KEY, useCollections, type Collection } from './queries'

interface CollectionFields {
  name: string
  description: string | null
}

type Editing = { mode: 'nova' } | { mode: 'editar'; collection: Collection } | { mode: 'excluir'; collection: Collection }

export function CollectionsPage() {
  useHelpTopic('colecoes')
  const collections = useCollections()
  const [editing, setEditing] = useState<Editing | null>(null)
  const items = collections.data?.items ?? []
  const close = () => setEditing(null)

  return (
    <section className={styles.page}>
      <PageHead
        kicker="Organizar"
        title="Coleções"
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setEditing({ mode: 'nova' })}>
            Nova coleção
          </button>
        }
      />
      <p className="text-muted">
        Coleção agrupa gravações; tag marca assuntos. As duas convivem, e uma gravação pode estar em várias coleções.
      </p>

      {collections.isPending && <p role="status">Carregando coleções…</p>}
      {collections.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(collections.error)}
        </p>
      )}
      {collections.isSuccess && items.length === 0 && (
        <p className={styles.empty}>Nenhuma coleção ainda. Crie uma e escolha as gravações na página de cada uma.</p>
      )}
      {items.length > 0 && (
        <ul className={`list ${styles.list}`} aria-label="Coleções">
          {items.map((collection) => (
            <CollectionRow
              key={collection.id}
              collection={collection}
              onEdit={() => setEditing({ mode: 'editar', collection })}
              onDelete={() => setEditing({ mode: 'excluir', collection })}
            />
          ))}
        </ul>
      )}

      {editing?.mode === 'nova' && <CreateDialog onClose={close} />}
      {editing?.mode === 'editar' && <EditDialog collection={editing.collection} onClose={close} />}
      {editing?.mode === 'excluir' && <DeleteDialog collection={editing.collection} onClose={close} />}
    </section>
  )
}

function CollectionRow({
  collection,
  onEdit,
  onDelete,
}: {
  collection: Collection
  onEdit: () => void
  onDelete: () => void
}) {
  const count = collection.recording_count
  return (
    <li className="list-row">
      <span className="list-row-title">{collection.name}</span>
      <span className="list-row-sub">
        {collection.description && <span className={styles.description}>{collection.description}</span>}
        <span className={styles.meta}>
          <span className="tabular">{count === 1 ? '1 gravação' : `${count} gravações`}</span>
          <Link to={`/?colecao=${collection.id}`}>Ver gravações</Link>
        </span>
      </span>
      <span className="list-row-actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onEdit} aria-label={`Editar ${collection.name}`}>
          Editar
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={onDelete}
          aria-label={`Excluir ${collection.name}`}
        >
          Excluir
        </button>
      </span>
    </li>
  )
}

function useInvalidateCollections() {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: COLLECTIONS_KEY })
}

function CreateDialog({ onClose }: { onClose: () => void }) {
  const invalidate = useInvalidateCollections()
  const create = useMutation({
    mutationFn: (fields: CollectionFields) => unwrap(api.POST('/api/v1/collections', { body: fields })),
    onSuccess: () => {
      invalidate()
      onClose()
    },
  })
  return (
    <Dialog title="Nova coleção" onClose={onClose} plain>
      <CollectionForm
        submitLabel="Criar coleção"
        pending={create.isPending}
        error={create.error}
        onSubmit={(fields) => create.mutate(fields)}
        onCancel={onClose}
      />
    </Dialog>
  )
}

function EditDialog({ collection, onClose }: { collection: Collection; onClose: () => void }) {
  const invalidate = useInvalidateCollections()
  const save = useMutation({
    mutationFn: (fields: CollectionFields) =>
      unwrap(
        api.PATCH('/api/v1/collections/{collection_id}', {
          params: { path: { collection_id: collection.id } },
          body: fields,
        }),
      ),
    onSuccess: () => {
      invalidate()
      onClose()
    },
  })
  return (
    <Dialog title="Editar coleção" onClose={onClose} plain>
      <CollectionForm
        initial={collection}
        submitLabel="Salvar"
        pending={save.isPending}
        error={save.error}
        onSubmit={(fields) => save.mutate(fields)}
        onCancel={onClose}
      />
    </Dialog>
  )
}

function DeleteDialog({ collection, onClose }: { collection: Collection; onClose: () => void }) {
  const queryClient = useQueryClient()
  const invalidate = useInvalidateCollections()
  const remove = useMutation({
    mutationFn: () =>
      unwrap(api.DELETE('/api/v1/collections/{collection_id}', { params: { path: { collection_id: collection.id } } })),
    onSuccess: () => {
      invalidate()
      queryClient.invalidateQueries({ queryKey: ['recordings'] })
      onClose()
    },
  })
  return (
    <Dialog
      plain
      title={`Excluir ${collection.name}?`}
      message="As gravações saem da coleção e continuam na biblioteca."
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Manter
          </button>
          <button type="button" className="btn btn-danger" onClick={() => remove.mutate()} disabled={remove.isPending}>
            Excluir coleção
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
        <input
          id={`${id}-descricao`}
          className="input"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      {error != null && (
        <p className="alert alert-error" role="alert">
          {errorMessage(error)}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          Cancelar
        </button>
        <button type="submit" className="btn btn-primary" disabled={pending || !name.trim()}>
          {submitLabel}
        </button>
      </div>
    </form>
  )
}
