import { Trans, useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { errorMessage } from '../../api/problem'
import { useHelpTopic } from '../../app/help'
import { PageHead } from '../../app/PageHead'
import { FieldEditor } from './FieldEditor'
import styles from './Organize.module.css'
import { kindLabel, useFields, useSetAutoFill, type Field } from './queries'
import { NEW, useGuardedSelection } from './useGuardedSelection'
import { Switch } from '../../shared/Switch'

export function FieldsPage() {
  useHelpTopic('campos')
  const { t } = useTranslation('organize')
  const fields = useFields()
  // Only the user fields: the title comes from the agenda types (pattern and subject rule) and the tags
  // have their own registry, in Tags.
  const items = [...(fields.data?.items ?? [])]
    .filter((field) => field.builtin === null)
    .sort((a, b) => a.position - b.position)
  const { selected, select, apply, setDirty, discardDialog } = useGuardedSelection('campo')
  const current = selected === NEW ? null : (items.find((item) => item.id === selected) ?? (selected ? undefined : items[0]))
  // With no fields and no selection there is no panel: the text takes the place of the list until Novo campo.
  const missing = selected !== null && selected !== NEW && current === undefined

  return (
    <section className={styles.page}>
      <PageHead
        kicker={t('types.kicker')}
        title={t('fields.title')}
        actions={
          <button type="button" className="btn btn-primary" onClick={() => select(NEW)}>
            {t('fields.new')}
          </button>
        }
      />
      <p className="text-muted">
        <Trans t={t} i18nKey="fields.intro" components={{ automation: <Link to="/config/automacao" /> }} />
      </p>

      {fields.isPending && <p role="status">{t('fields.loading')}</p>}
      {fields.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(fields.error)}
        </p>
      )}
      {fields.isSuccess && (
        <div className={`split ${styles.split}`}>
          {items.length === 0 ? (
            <p className="text-muted">
              <Trans t={t} i18nKey="fields.empty" components={{ b: <strong /> }} />
            </p>
          ) : (
            <ul className={`list ${styles.list}`} aria-label={t('fields.list')}>
              {items.map((field) => (
                <FieldRow
                  key={field.id}
                  field={field}
                  selected={field.id === current?.id}
                  onSelect={() => select(field.id)}
                />
              ))}
            </ul>
          )}
          {current === undefined ? (
            missing && !fields.isFetching && (
              <p className="text-muted">{t('fields.gone')}</p>
            )
          ) : (
            <FieldEditor
              key={current?.id ?? NEW}
              field={current}
              onDirtyChange={setDirty}
              onSaved={(saved) => apply(saved.id)}
              onDeleted={() => apply(null)}
            />
          )}
        </div>
      )}
      {discardDialog}
    </section>
  )
}

function FieldRow({ field, selected, onSelect }: { field: Field; selected: boolean; onSelect: () => void }) {
  const { t } = useTranslation('organize')
  const setAutoFill = useSetAutoFill()
  return (
    <li className={selected ? `list-row ${styles.selected}` : 'list-row'}>
      <button
        type="button"
        className={`list-row-title ${styles.rowButton}`}
        aria-current={selected || undefined}
        onClick={onSelect}
      >
        {field.name}
      </button>
      <span className="list-row-sub">
        {t('fields.yours', { kind: kindLabel(field.kind).toLowerCase() })}
      </span>
      <span className="list-row-actions">
        <Switch
          checked={field.auto_fill}
          label={t('fields.autoLabel', { name: field.name })}
          onChange={(autoFill) => setAutoFill.mutate({ id: field.id, autoFill })}
        >
          <span aria-hidden="true">{t('fields.auto')}</span>
        </Switch>
        {setAutoFill.isError && (
          <span className={`field-hint ${styles.error}`} role="alert">
            {t('fields.autoFailed', { message: errorMessage(setAutoFill.error) })}
          </span>
        )}
      </span>
    </li>
  )
}
