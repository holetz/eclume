import { useMutation } from '@tanstack/react-query'
import { useId, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { api } from '../../api/client'
import { ApiError, errorMessage, unwrap } from '../../api/problem'
import { Dialog } from '../../app/Dialog'
import { useHelpTopic } from '../../app/help'
import { HelpHint } from '../../app/HelpHint'
import { PageHead } from '../../app/PageHead'
import { TagAssignmentCard } from './TagAssignmentCard'
import styles from './Tags.module.css'
import { useRefreshTags, useTags, type Tag } from './queries'

interface TagValues {
  name: string
  description: string
}

type Editing =
  | { mode: 'nova' }
  | { mode: 'editar'; tag: Tag }
  | { mode: 'mesclar'; tag: Tag }
  | { mode: 'excluir'; tag: Tag }

/** O erro de uma gravação de tag: o nome repetido ganha a saída certa, que é mesclar. */
function tagError(error: unknown): string {
  if (error instanceof ApiError && error.code === 'tag_exists') {
    return 'Já existe uma tag com esse nome. Para juntar as duas, use Mesclar.'
  }
  return errorMessage(error)
}

export function TagsPage() {
  useHelpTopic('tags')
  const tags = useTags()
  const [editing, setEditing] = useState<Editing | null>(null)
  const items = tags.data?.items ?? []
  const close = () => setEditing(null)

  return (
    <section className={styles.page}>
      <PageHead
        kicker="Organizar"
        title="Tags"
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setEditing({ mode: 'nova' })}>
            Nova tag
          </button>
        }
      />
      <p className="text-muted">
        As tags marcam assuntos. Por padrão, o agente só usa as tags cadastradas aqui, e a descrição de cada uma
        (quando usar) vai junto para ele decidir. A tag que você escreve numa gravação entra no cadastro sozinha.{' '}
        <Link to="/ajuda/tags-cadastradas">Saiba como funciona</Link>. Veja em que ponto as tags entram em{' '}
        <Link to="/config/automacao">Processamento automático</Link>.
      </p>

      <TagAssignmentCard />

      {tags.isPending && <p role="status">Carregando tags…</p>}
      {tags.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(tags.error)}
        </p>
      )}
      {tags.isSuccess && items.length === 0 && (
        <p className={styles.empty}>Nenhuma tag ainda. Crie uma com Nova tag, ou escreva tags numa gravação.</p>
      )}
      {items.length > 0 && (
        <ul className={`list ${styles.list}`} aria-label="Tags">
          {items.map((tag) => (
            <TagRow
              key={tag.id}
              tag={tag}
              onEdit={() => setEditing({ mode: 'editar', tag })}
              onMerge={items.length > 1 ? () => setEditing({ mode: 'mesclar', tag }) : undefined}
              onDelete={() => setEditing({ mode: 'excluir', tag })}
            />
          ))}
        </ul>
      )}

      {editing?.mode === 'nova' && <CreateDialog onClose={close} />}
      {editing?.mode === 'editar' && <EditDialog tag={editing.tag} onClose={close} />}
      {editing?.mode === 'mesclar' && (
        <MergeDialog tag={editing.tag} targets={items.filter((item) => item.id !== editing.tag.id)} onClose={close} />
      )}
      {editing?.mode === 'excluir' && <DeleteDialog tag={editing.tag} onClose={close} />}
    </section>
  )
}

function TagRow({
  tag,
  onEdit,
  onMerge,
  onDelete,
}: {
  tag: Tag
  onEdit: () => void
  /** Sem outra tag, não há onde mesclar. */
  onMerge?: () => void
  onDelete: () => void
}) {
  return (
    <li className="list-row">
      <span className="list-row-title">
        {tag.name}
        {tag.origin === 'auto' && <span className={`badge ${styles.badge}`}>Criada pelo agente</span>}
      </span>
      <span className="list-row-sub">
        {tag.description && <span className={styles.description}>{tag.description}</span>}
        <span className={styles.meta}>
          <span className="tabular">{tag.count === 1 ? '1 gravação' : `${tag.count} gravações`}</span>
          <Link to={`/?tag=${encodeURIComponent(tag.name)}`}>Ver gravações</Link>
        </span>
      </span>
      <span className="list-row-actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onEdit} aria-label={`Editar ${tag.name}`}>
          Editar
        </button>
        {onMerge && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onMerge}
            aria-label={`Mesclar ${tag.name} em outra tag`}
          >
            Mesclar em…
          </button>
        )}
        <button type="button" className="btn btn-ghost btn-sm" onClick={onDelete} aria-label={`Excluir ${tag.name}`}>
          Excluir
        </button>
      </span>
    </li>
  )
}

function CreateDialog({ onClose }: { onClose: () => void }) {
  const refresh = useRefreshTags()
  const create = useMutation({
    mutationFn: (values: TagValues) => unwrap(api.POST('/api/v1/tags', { body: values })),
    onSuccess: () => {
      refresh(false)
      onClose()
    },
  })
  return (
    <Dialog title="Nova tag" onClose={onClose} plain>
      <TagForm
        submitLabel="Criar tag"
        pending={create.isPending}
        error={create.error}
        onSubmit={(values) => create.mutate(values)}
        onCancel={onClose}
      />
    </Dialog>
  )
}

function EditDialog({ tag, onClose }: { tag: Tag; onClose: () => void }) {
  const refresh = useRefreshTags()
  const save = useMutation({
    // Só o que mudou; renomear troca o nome nas gravações também.
    mutationFn: (values: TagValues) => {
      const body = {
        ...(values.name !== tag.name && { name: values.name }),
        ...(values.description !== tag.description && { description: values.description }),
      }
      return unwrap(api.PATCH('/api/v1/tags/{tag_id}', { params: { path: { tag_id: tag.id } }, body }))
    },
    onSuccess: (_saved, values) => {
      refresh(values.name !== tag.name)
      onClose()
    },
  })
  return (
    <Dialog title="Editar tag" onClose={onClose} plain>
      <TagForm
        initial={tag}
        submitLabel="Salvar"
        pending={save.isPending}
        error={save.error}
        onSubmit={(values) => save.mutate(values)}
        onCancel={onClose}
      />
    </Dialog>
  )
}

function MergeDialog({ tag, targets, onClose }: { tag: Tag; targets: Tag[]; onClose: () => void }) {
  const refresh = useRefreshTags()
  const [into, setInto] = useState(targets[0]?.id ?? '')
  const id = useId()
  const target = targets.find((item) => item.id === into)
  const merge = useMutation({
    mutationFn: () =>
      unwrap(api.POST('/api/v1/tags/{tag_id}/merge', { params: { path: { tag_id: tag.id } }, body: { into } })),
    onSuccess: () => {
      refresh(true)
      onClose()
    },
  })
  return (
    <Dialog
      plain
      title={`Mesclar ${tag.name}`}
      message={`Onde havia ${tag.name}, passa a haver a tag escolhida, nas gravações e nas tags padrão dos tipos de agenda. ${tag.name} sai do cadastro, e a tag escolhida fica com o nome e a descrição dela.`}
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

function DeleteDialog({ tag, onClose }: { tag: Tag; onClose: () => void }) {
  const refresh = useRefreshTags()
  const remove = useMutation({
    mutationFn: () => unwrap(api.DELETE('/api/v1/tags/{tag_id}', { params: { path: { tag_id: tag.id } } })),
    onSuccess: () => {
      refresh(true)
      onClose()
    },
  })
  return (
    <Dialog
      plain
      title={`Excluir ${tag.name}?`}
      message="A tag sai do cadastro, de todas as gravações e das tags padrão dos tipos de agenda. As gravações continuam na biblioteca."
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Manter
          </button>
          <button type="button" className="btn btn-danger" onClick={() => remove.mutate()} disabled={remove.isPending}>
            Excluir tag
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

interface TagFormProps {
  initial?: Tag
  submitLabel: string
  pending: boolean
  error: unknown
  onSubmit: (values: TagValues) => void
  onCancel: () => void
}

function TagForm({ initial, submitLabel, pending, error, onSubmit, onCancel }: TagFormProps) {
  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const id = useId()
  const cleanName = name.trim()
  const cleanDescription = description.trim()
  const changed = !initial || cleanName !== initial.name || cleanDescription !== initial.description

  function submit(event: FormEvent) {
    event.preventDefault()
    if (cleanName && changed) onSubmit({ name: cleanName, description: cleanDescription })
  }

  return (
    <form className={styles.form} onSubmit={submit}>
      <div className="field">
        <label htmlFor={`${id}-nome`}>Nome da tag</label>
        <input
          id={`${id}-nome`}
          className="input"
          value={name}
          maxLength={64}
          required
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="field">
        <div className={styles.labelRow}>
          <label htmlFor={`${id}-quando`}>Quando usar</label>
          <HelpHint subject="as tags cadastradas" title="Quando usar" article="tags-cadastradas">
            O agente lê o nome e esta descrição de cada tag antes de escolher. Diga em que tipo de conversa a tag
            serve, e quando ela não serve.
          </HelpHint>
        </div>
        <textarea
          id={`${id}-quando`}
          className={`input ${styles.when}`}
          value={description}
          maxLength={4000}
          placeholder="Por exemplo: conversas sobre contratos ou prazos com a Metalúrgica Serra Azul."
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      {error != null && (
        <p className="alert alert-error" role="alert">
          {tagError(error)}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          Cancelar
        </button>
        <button type="submit" className="btn btn-primary" disabled={pending || !cleanName || !changed}>
          {submitLabel}
        </button>
      </div>
    </form>
  )
}
