import { errorMessage } from '../../api/problem'
import { useHelpTopic } from '../../app/help'
import { PageHead } from '../../app/PageHead'
import { FieldEditor } from './FieldEditor'
import styles from './Organize.module.css'
import { KIND_LABELS, useFields, useSetAutoFill, type Field } from './queries'
import { NEW, useGuardedSelection } from './useGuardedSelection'

export function FieldsPage() {
  useHelpTopic('campos')
  const fields = useFields()
  const items = [...(fields.data?.items ?? [])].sort((a, b) => a.position - b.position)
  const { selected, select, apply, setDirty, discardDialog } = useGuardedSelection('campo')
  const current = selected === NEW ? null : (items.find((f) => f.id === selected) ?? (selected ? undefined : items[0]))

  return (
    <section className={styles.page}>
      <PageHead
        kicker="Organizar"
        title="Campos e regras"
        actions={
          <button type="button" className="btn btn-primary" onClick={() => select(NEW)}>
            Novo campo
          </button>
        }
      />
      <p className="text-muted">
        O que o eclume preenche em toda gravação depois da transcrição. Título e tags vêm embutidos; os
        outros campos são seus.
      </p>

      {fields.isPending && <p role="status">Carregando campos…</p>}
      {fields.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(fields.error)}
        </p>
      )}
      {fields.isSuccess && (
        <div className={`split ${styles.split}`}>
          <ul className={`list ${styles.list}`} aria-label="Campos">
            {items.map((field) => (
              <FieldRow
                key={field.id}
                field={field}
                selected={field.id === current?.id}
                onSelect={() => select(field.id)}
              />
            ))}
          </ul>
          {current === undefined ? (
            !fields.isFetching && <p className="text-muted">Este campo não existe mais. Escolha outro na lista.</p>
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
  const setAutoFill = useSetAutoFill()
  const origin = field.builtin ? 'Embutido' : 'Seu campo'
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
        {origin} · {KIND_LABELS[field.kind].toLowerCase()}
      </span>
      <span className="list-row-actions">
        <label className="switch">
          <input
            type="checkbox"
            checked={field.auto_fill}
            aria-label={`Automático: ${field.name}`}
            onChange={(event) => setAutoFill.mutate({ id: field.id, autoFill: event.target.checked })}
          />
          <span className="track" />
          <span aria-hidden="true">Automático</span>
        </label>
        {setAutoFill.isError && (
          <span className={`field-hint ${styles.error}`} role="alert">
            Não deu para mudar. {errorMessage(setAutoFill.error)}
          </span>
        )}
      </span>
    </li>
  )
}
