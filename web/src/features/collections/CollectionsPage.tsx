import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { api } from '../../api/client'
import { errorMessage, unwrap } from '../../api/problem'
import { Dialog } from '../../app/Dialog'
import { useHelpTopic } from '../../app/help'
import { HelpHint } from '../../app/HelpHint'
import { PageHead } from '../../app/PageHead'
import styles from './CollectionsPage.module.css'
import { COLLECTIONS_KEY, useCollections, type Collection } from './queries'

interface CollectionFields {
  name: string
  description: string | null
  instructions: string
  auto_assign: boolean
}

type Editing =
  | { mode: 'nova' }
  | { mode: 'editar'; collection: Collection }
  | { mode: 'mesclar'; collection: Collection }
  | { mode: 'excluir'; collection: Collection }

/** Regras de exemplo para "Quando incluir": assunto, tipo de agenda e dados dos participantes. */
const RULE_EXAMPLES = [
  'Reuniões em que participa alguém da empresa Agro Sul.',
  'Conversas do tipo Conversa com cliente com alguém que tenha a tag de pessoa "diretoria".',
  'Quando a conversa tratar do projeto Horizonte: cronograma, orçamento ou entregas.',
  'Reuniões com alguém da área Financeiro ou com o cargo de gerente, menos as notas de voz.',
]

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
        Uma coleção com regra e <strong>Incluir automaticamente</strong> recebe as gravações que o agente
        achar que cumprem a regra, depois da transcrição.
      </p>
      <p className="text-muted">
        No app desktop, as coleções também organizam a pasta sincronizada: cada uma vira uma subpasta com os
        resumos e as transcrições. <Link to="/ajuda/pasta-sincronizada">Saiba como funciona</Link>.
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
              onMerge={items.length > 1 ? () => setEditing({ mode: 'mesclar', collection }) : undefined}
              onDelete={() => setEditing({ mode: 'excluir', collection })}
            />
          ))}
        </ul>
      )}

      {editing?.mode === 'nova' && <CreateDialog onClose={close} />}
      {editing?.mode === 'editar' && <EditDialog collection={editing.collection} onClose={close} />}
      {editing?.mode === 'mesclar' && (
        <MergeDialog
          collection={editing.collection}
          targets={items.filter((item) => item.id !== editing.collection.id)}
          onClose={close}
        />
      )}
      {editing?.mode === 'excluir' && <DeleteDialog collection={editing.collection} onClose={close} />}
    </section>
  )
}

function CollectionRow({
  collection,
  onEdit,
  onMerge,
  onDelete,
}: {
  collection: Collection
  onEdit: () => void
  /** Sem outra coleção, não há onde mesclar. */
  onMerge?: () => void
  onDelete: () => void
}) {
  const count = collection.recording_count
  const automatic = collection.auto_assign && collection.instructions.trim() !== ''
  return (
    <li className="list-row">
      <span className="list-row-title">
        {collection.name}
        {automatic && <span className={`badge ${styles.badge}`}>Automática</span>}
      </span>
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
        {onMerge && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onMerge}
            aria-label={`Mesclar ${collection.name} em outra coleção`}
          >
            Mesclar em…
          </button>
        )}
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

function MergeDialog({ collection, targets, onClose }: { collection: Collection; targets: Collection[]; onClose: () => void }) {
  const queryClient = useQueryClient()
  const invalidate = useInvalidateCollections()
  const [into, setInto] = useState(targets[0]?.id ?? '')
  const id = useId()
  const target = targets.find((item) => item.id === into)
  const merge = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/api/v1/collections/{collection_id}/merge', {
          params: { path: { collection_id: collection.id } },
          body: { into },
        }),
      ),
    onSuccess: () => {
      invalidate()
      queryClient.invalidateQueries({ queryKey: ['recordings'] })
      onClose()
    },
  })
  return (
    <Dialog
      plain
      title={`Mesclar ${collection.name}`}
      message={`As gravações de ${collection.name} passam para a coleção escolhida, e ${collection.name} é excluída. A coleção escolhida fica com o nome, a descrição e a regra dela.`}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancelar
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => merge.mutate()}
            disabled={merge.isPending || !target}
          >
            {target ? `Mesclar em ${target.name}` : 'Mesclar'}
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor={`${id}-destino`}>Mesclar em</label>
        <select id={`${id}-destino`} className="input" value={into} onChange={(e) => setInto(e.target.value)}>
          {targets.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </div>
      {merge.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(merge.error)}
        </p>
      )}
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
  const [instructions, setInstructions] = useState(initial?.instructions ?? '')
  const [autoAssign, setAutoAssign] = useState(initial?.auto_assign ?? false)
  const id = useId()

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!name.trim()) return
    onSubmit({
      name: name.trim(),
      description: description.trim() || null,
      instructions: instructions.trim(),
      auto_assign: autoAssign,
    })
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
      <div className="field">
        <div className={styles.labelRow}>
          <label htmlFor={`${id}-regra`}>Quando incluir</label>
          <HelpHint subject="as coleções automáticas" title="Coleções automáticas" article="colecoes-automaticas">
            Depois da transcrição, o agente lê a conversa, o tipo de agenda e os participantes (empresa, área,
            cargo e tags de cada pessoa ligada a um locutor) e inclui a gravação nas coleções cuja regra ela
            cumpre.
          </HelpHint>
        </div>
        <textarea
          id={`${id}-regra`}
          className={`input ${styles.rule}`}
          value={instructions}
          maxLength={4000}
          placeholder="Por exemplo: reuniões em que participa alguém da empresa Agro Sul."
          aria-describedby={`${id}-regra-dica`}
          onChange={(e) => setInstructions(e.target.value)}
        />
        <span id={`${id}-regra-dica`} className="field-hint">
          Diga o que a gravação precisa ter. Pode citar o assunto, o tipo de agenda e os dados dos participantes.
        </span>
        <details className={styles.examples}>
          <summary>Exemplos de regras</summary>
          <ul>
            {RULE_EXAMPLES.map((example) => (
              <li key={example}>
                <span>{example}</span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  aria-label={`Usar o exemplo: ${example}`}
                  onClick={() => setInstructions(example)}
                >
                  Usar
                </button>
              </li>
            ))}
          </ul>
        </details>
      </div>
      <label className="switch">
        <input type="checkbox" checked={autoAssign} onChange={(e) => setAutoAssign(e.target.checked)} />
        <span className="track" />
        Incluir automaticamente depois da transcrição
      </label>
      {autoAssign && !instructions.trim() && (
        <p className="field-hint" role="status">
          Sem regra, o agente não inclui nada nesta coleção.
        </p>
      )}
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
