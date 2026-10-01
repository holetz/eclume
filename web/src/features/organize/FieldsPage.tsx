import { Link } from 'react-router'
import { errorMessage } from '../../api/problem'
import { useHelpTopic } from '../../app/help'
import { PageHead } from '../../app/PageHead'
import { FieldEditor } from './FieldEditor'
import styles from './Organize.module.css'
import { KIND_LABELS, useFields, useSetAutoFill, type Field } from './queries'
import { NEW, useGuardedSelection } from './useGuardedSelection'
import { Switch } from '../../shared/Switch'

export function FieldsPage() {
  useHelpTopic('campos')
  const fields = useFields()
  // Só os campos do usuário: o título vem dos tipos de agenda (padrão e regra do assunto) e as tags
  // têm cadastro próprio, em Tags.
  const items = [...(fields.data?.items ?? [])]
    .filter((field) => field.builtin === null)
    .sort((a, b) => a.position - b.position)
  const { selected, select, apply, setDirty, discardDialog } = useGuardedSelection('campo')
  const current = selected === NEW ? null : (items.find((f) => f.id === selected) ?? (selected ? undefined : items[0]))
  // Sem campos e sem escolha não há painel: o texto ocupa o lugar da lista até o Novo campo.
  const missing = selected !== null && selected !== NEW && current === undefined

  return (
    <section className={styles.page}>
      <PageHead
        kicker="Regras"
        title="Campos personalizados"
        actions={
          <button type="button" className="btn btn-primary" onClick={() => select(NEW)}>
            Novo campo
          </button>
        }
      />
      <p className="text-muted">
        O que o eclume preenche em toda gravação depois da transcrição, cada campo com a regra que o agente
        segue. O título, as tags e o resto do que acontece sozinho depois de cada gravação estão em{' '}
        <Link to="/config/automacao">Processamento automático</Link>.
      </p>

      {fields.isPending && <p role="status">Carregando campos…</p>}
      {fields.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(fields.error)}
        </p>
      )}
      {fields.isSuccess && (
        <div className={`split ${styles.split}`}>
          {items.length === 0 ? (
            <p className="text-muted">
              Nenhum campo personalizado ainda. Crie um com Novo campo: por exemplo, <strong>Cliente</strong>, com a
              regra “A empresa cliente citada na reunião; vazio se nenhuma for citada”.
            </p>
          ) : (
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
          )}
          {current === undefined ? (
            missing && !fields.isFetching && (
              <p className="text-muted">Este campo não existe mais. Escolha outro na lista.</p>
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
        Seu campo · {KIND_LABELS[field.kind].toLowerCase()}
      </span>
      <span className="list-row-actions">
        <Switch
          checked={field.auto_fill}
          label={`Automático: ${field.name}`}
          onChange={(autoFill) => setAutoFill.mutate({ id: field.id, autoFill })}
        >
          <span aria-hidden="true">Automático</span>
        </Switch>
        {setAutoFill.isError && (
          <span className={`field-hint ${styles.error}`} role="alert">
            Não deu para mudar. {errorMessage(setAutoFill.error)}
          </span>
        )}
      </span>
    </li>
  )
}
