import { useMutation } from '@tanstack/react-query'
import { useId, useState, type FormEvent } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { api } from '../../api/client'
import { ApiError, errorMessage, unwrap } from '../../api/problem'
import { Dialog } from '../../app/Dialog'
import { i18n } from '../../i18n'
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

/** The error of a tag save: the duplicate name gets the right way out, which is merging. */
function tagError(error: unknown): string {
  if (error instanceof ApiError && error.code === 'tag_exists') {
    return i18n.t('tags:exists')
  }
  return errorMessage(error)
}

export function TagsPage() {
  useHelpTopic('tags')
  const { t } = useTranslation('tags')
  const tags = useTags()
  const [editing, setEditing] = useState<Editing | null>(null)
  const items = tags.data?.items ?? []
  const close = () => setEditing(null)

  return (
    <section className={styles.page}>
      <PageHead
        kicker={t('kicker')}
        title={t('title')}
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setEditing({ mode: 'nova' })}>
            {t('new')}
          </button>
        }
      />
      <p className="text-muted">
        <Trans
          t={t}
          i18nKey="intro"
          components={{ how: <Link to="/ajuda/tags-cadastradas" />, automation: <Link to="/config/automacao" /> }}
        />
      </p>

      <TagAssignmentCard />

      {tags.isPending && <p role="status">{t('loading')}</p>}
      {tags.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(tags.error)}
        </p>
      )}
      {tags.isSuccess && items.length === 0 && (
        <p className={styles.empty}>{t('empty')}</p>
      )}
      {items.length > 0 && (
        <ul className={`list ${styles.list}`} aria-label={t('title')}>
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
  /** With no other tag, there is nowhere to merge. */
  onMerge?: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation('tags')
  return (
    <li className="list-row">
      <span className="list-row-title">
        {tag.name}
        {tag.origin === 'auto' && <span className={`badge ${styles.badge}`}>{t('byAgent')}</span>}
      </span>
      <span className="list-row-sub">
        {tag.description && <span className={styles.description}>{tag.description}</span>}
        <span className={styles.meta}>
          <span className="tabular">{t('count', { count: tag.count })}</span>
          <Link to={`/?tag=${encodeURIComponent(tag.name)}`}>{t('see')}</Link>
        </span>
      </span>
      <span className="list-row-actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onEdit} aria-label={t('editLabel', { name: tag.name })}>
          {t('edit')}
        </button>
        {onMerge && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onMerge}
            aria-label={t('mergeLabel', { name: tag.name })}
          >
            {t('mergeInto')}
          </button>
        )}
        <button type="button" className="btn btn-ghost btn-sm" onClick={onDelete} aria-label={t('deleteLabel', { name: tag.name })}>
          {t('delete')}
        </button>
      </span>
    </li>
  )
}

function CreateDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('tags')
  const refresh = useRefreshTags()
  const create = useMutation({
    mutationFn: (values: TagValues) => unwrap(api.POST('/api/v1/tags', { body: values })),
    onSuccess: () => {
      refresh(false)
      onClose()
    },
  })
  return (
    <Dialog title={t('new')} onClose={onClose} plain>
      <TagForm
        submitLabel={t('create')}
        pending={create.isPending}
        error={create.error}
        onSubmit={(values) => create.mutate(values)}
        onCancel={onClose}
      />
    </Dialog>
  )
}

function EditDialog({ tag, onClose }: { tag: Tag; onClose: () => void }) {
  const { t } = useTranslation(['tags', 'common'])
  const refresh = useRefreshTags()
  const save = useMutation({
    // Only what changed; renaming also changes the name in the recordings.
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
    <Dialog title={t('editTitle')} onClose={onClose} plain>
      <TagForm
        initial={tag}
        submitLabel={t('common:save')}
        pending={save.isPending}
        error={save.error}
        onSubmit={(values) => save.mutate(values)}
        onCancel={onClose}
      />
    </Dialog>
  )
}

function MergeDialog({ tag, targets, onClose }: { tag: Tag; targets: Tag[]; onClose: () => void }) {
  const { t } = useTranslation(['tags', 'common'])
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
      title={t('mergeTitle', { name: tag.name })}
      message={t('mergeText', { name: tag.name })}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            {t('common:cancel')}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => merge.mutate()}
            disabled={merge.isPending || !target}
          >
            {target ? t('mergeTo', { name: target.name }) : t('merge')}
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor={`${id}-destino`}>{t('mergeField')}</label>
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
  const { t } = useTranslation('tags')
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
      title={t('deleteTitle', { name: tag.name })}
      message={t('deleteText')}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            {t('keep')}
          </button>
          <button type="button" className="btn btn-danger" onClick={() => remove.mutate()} disabled={remove.isPending}>
            {t('deleteConfirm')}
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
  const { t } = useTranslation(['tags', 'common'])
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
        <label htmlFor={`${id}-nome`}>{t('form.name')}</label>
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
          <label htmlFor={`${id}-quando`}>{t('form.when')}</label>
          <HelpHint subject={t('form.hintSubject')} title={t('form.when')} article="tags-cadastradas">
            {t('form.hint')}
          </HelpHint>
        </div>
        <textarea
          id={`${id}-quando`}
          className={`input ${styles.when}`}
          value={description}
          maxLength={4000}
          placeholder={t('form.placeholder')}
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
          {t('common:cancel')}
        </button>
        <button type="submit" className="btn btn-primary" disabled={pending || !cleanName || !changed}>
          {submitLabel}
        </button>
      </div>
    </form>
  )
}
