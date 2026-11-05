import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, useState, type FormEvent } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { api } from '../../api/client'
import { errorMessage, unwrap } from '../../api/problem'
import { Dialog } from '../../app/Dialog'
import { useHelpTopic } from '../../app/help'
import { HelpHint } from '../../app/HelpHint'
import { PageHead } from '../../app/PageHead'
import styles from './CollectionsPage.module.css'
import { COLLECTIONS_KEY, useCollections, type Collection } from './queries'
import { Switch } from '../../shared/Switch'

interface CollectionFields {
  name: string
  description: string | null
  instructions: string
  auto_assign: boolean
}

type Editing =
  | { mode: 'new' }
  | { mode: 'edit'; collection: Collection }
  | { mode: 'merge'; collection: Collection }
  | { mode: 'delete'; collection: Collection }

/** Example rules for "Quando incluir": subject, agenda type and participant data. */
const RULE_EXAMPLES = ['subject', 'type', 'project', 'department'] as const

export function CollectionsPage() {
  useHelpTopic('colecoes')
  const { t } = useTranslation('collections')
  const collections = useCollections()
  const [editing, setEditing] = useState<Editing | null>(null)
  const items = collections.data?.items ?? []
  const close = () => setEditing(null)

  return (
    <section className={styles.page}>
      <PageHead
        kicker={t('kicker')}
        title={t('title')}
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setEditing({ mode: 'new' })}>
            {t('new')}
          </button>
        }
      />
      <p className="text-muted">
        <Trans
          t={t}
          i18nKey="intro"
          components={{ b: <strong />, automation: <Link to="/config/automacao" /> }}
        />
      </p>
      <p className="text-muted">
        <Trans t={t} i18nKey="desktop" components={{ folder: <Link to="/ajuda/pasta-sincronizada" /> }} />
      </p>

      {collections.isPending && <p role="status">{t('loading')}</p>}
      {collections.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(collections.error)}
        </p>
      )}
      {collections.isSuccess && items.length === 0 && (
        <p className={styles.empty}>
          <Trans t={t} i18nKey="empty" components={{ b: <strong /> }} />
        </p>
      )}
      {items.length > 0 && (
        <ul className={`list ${styles.list}`} aria-label={t('title')}>
          {items.map((collection) => (
            <CollectionRow
              key={collection.id}
              collection={collection}
              onEdit={() => setEditing({ mode: 'edit', collection })}
              onMerge={items.length > 1 ? () => setEditing({ mode: 'merge', collection }) : undefined}
              onDelete={() => setEditing({ mode: 'delete', collection })}
            />
          ))}
        </ul>
      )}

      {editing?.mode === 'new' && <CreateDialog onClose={close} />}
      {editing?.mode === 'edit' && <EditDialog collection={editing.collection} onClose={close} />}
      {editing?.mode === 'merge' && (
        <MergeDialog
          collection={editing.collection}
          targets={items.filter((item) => item.id !== editing.collection.id)}
          onClose={close}
        />
      )}
      {editing?.mode === 'delete' && <DeleteDialog collection={editing.collection} onClose={close} />}
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
  /** Without another collection, there is nowhere to merge. */
  onMerge?: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation('collections')
  const count = collection.recording_count
  const automatic = collection.auto_assign && collection.instructions.trim() !== ''
  return (
    <li className="list-row">
      <span className="list-row-title">
        {collection.name}
        {automatic && <span className={`badge ${styles.badge}`}>{t('automatic')}</span>}
      </span>
      <span className="list-row-sub">
        {collection.description && <span className={styles.description}>{collection.description}</span>}
        <span className={styles.meta}>
          <span className="tabular">{t('count', { count })}</span>
          <Link to={`/?colecao=${collection.id}`}>{t('see')}</Link>
        </span>
      </span>
      <span className="list-row-actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onEdit} aria-label={t('editLabel', { name: collection.name })}>
          {t('edit')}
        </button>
        {onMerge && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onMerge}
            aria-label={t('mergeLabel', { name: collection.name })}
          >
            {t('mergeInto')}
          </button>
        )}
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={onDelete}
          aria-label={t('deleteLabel', { name: collection.name })}
        >
          {t('delete')}
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
  const { t } = useTranslation('collections')
  const invalidate = useInvalidateCollections()
  const create = useMutation({
    mutationFn: (fields: CollectionFields) => unwrap(api.POST('/api/v1/collections', { body: fields })),
    onSuccess: () => {
      invalidate()
      onClose()
    },
  })
  return (
    <Dialog title={t('new')} onClose={onClose} plain>
      <CollectionForm
        submitLabel={t('create')}
        pending={create.isPending}
        error={create.error}
        onSubmit={(fields) => create.mutate(fields)}
        onCancel={onClose}
      />
    </Dialog>
  )
}

function EditDialog({ collection, onClose }: { collection: Collection; onClose: () => void }) {
  const { t } = useTranslation(['collections', 'common'])
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
    <Dialog title={t('editTitle')} onClose={onClose} plain>
      <CollectionForm
        initial={collection}
        submitLabel={t('common:save')}
        pending={save.isPending}
        error={save.error}
        onSubmit={(fields) => save.mutate(fields)}
        onCancel={onClose}
      />
    </Dialog>
  )
}

function MergeDialog({ collection, targets, onClose }: { collection: Collection; targets: Collection[]; onClose: () => void }) {
  const { t } = useTranslation(['collections', 'common'])
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
      title={t('mergeTitle', { name: collection.name })}
      message={t('mergeText', { name: collection.name })}
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

function DeleteDialog({ collection, onClose }: { collection: Collection; onClose: () => void }) {
  const { t } = useTranslation('collections')
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
      title={t('deleteTitle', { name: collection.name })}
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

interface CollectionFormProps {
  initial?: CollectionFields
  submitLabel: string
  pending: boolean
  error: unknown
  onSubmit: (fields: CollectionFields) => void
  onCancel: () => void
}

function CollectionForm({ initial, submitLabel, pending, error, onSubmit, onCancel }: CollectionFormProps) {
  const { t } = useTranslation(['collections', 'common'])
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
        <label htmlFor={`${id}-nome`}>{t('form.name')}</label>
        <input id={`${id}-nome`} className="input" value={name} onChange={(e) => setName(e.target.value)} required />
      </div>
      <div className="field">
        <label htmlFor={`${id}-descricao`}>{t('form.description')}</label>
        <input
          id={`${id}-descricao`}
          className="input"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div className="field">
        <div className={styles.labelRow}>
          <label htmlFor={`${id}-regra`}>{t('form.rule')}</label>
          <HelpHint subject={t('form.hintSubject')} title={t('form.hintTitle')} article="colecoes-automaticas">
            {t('form.hint')}
          </HelpHint>
        </div>
        <textarea
          id={`${id}-regra`}
          className={`input ${styles.rule}`}
          value={instructions}
          maxLength={4000}
          placeholder={t('form.placeholder')}
          aria-describedby={`${id}-regra-dica`}
          onChange={(e) => setInstructions(e.target.value)}
        />
        <span id={`${id}-regra-dica`} className="field-hint">
          {t('form.ruleHint')}
        </span>
        <details className={styles.examples}>
          <summary>{t('form.examples')}</summary>
          <ul>
            {RULE_EXAMPLES.map((key) => {
              const example = t(`example.${key}`)
              return (
              <li key={key}>
                <span>{example}</span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  aria-label={t('form.useLabel', { example })}
                  onClick={() => setInstructions(example)}
                >
                  {t('form.use')}
                </button>
              </li>
              )
            })}
          </ul>
        </details>
      </div>
      <Switch checked={autoAssign} onChange={setAutoAssign}>
        {t('form.auto')}
      </Switch>
      {autoAssign && !instructions.trim() && (
        <p className="field-hint" role="status">
          {t('form.noRule')}
        </p>
      )}
      {error != null && (
        <p className="alert alert-error" role="alert">
          {errorMessage(error)}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          {t('common:cancel')}
        </button>
        <button type="submit" className="btn btn-primary" disabled={pending || !name.trim()}>
          {submitLabel}
        </button>
      </div>
    </form>
  )
}
