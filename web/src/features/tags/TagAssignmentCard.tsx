import { useId, useState } from 'react'
import { errorMessage } from '../../api/problem'
import { Switch } from '../../shared/Switch'
import styles from './Tags.module.css'
import { useTagAssignment, useUpdateTagAssignment, type TagAssignment } from './queries'

const MODES = [
  {
    value: 'fixed',
    label: 'Só as tags cadastradas',
    hint: 'O agente escolhe entre as tags da lista abaixo e descarta qualquer outra.',
  },
  {
    value: 'auto',
    label: 'O agente pode criar tags',
    hint: 'Quando nenhuma tag cadastrada serve, o agente cadastra uma nova. As que ele cria ganham o selo "Criada pelo agente".',
  },
] as const

/** From 1 to 5, like the contract. */
const LIMITS = [1, 2, 3, 4, 5]

/** How the agent assigns the tags after transcription: toggle, general rule, mode and limit. */
export function TagAssignmentCard() {
  const assignment = useTagAssignment()
  if (assignment.isPending) return <p role="status">Carregando a configuração das tags…</p>
  if (assignment.isError) {
    return (
      <p className="alert alert-error" role="alert">
        {errorMessage(assignment.error)}
      </p>
    )
  }
  return <TagAssignmentForm assignment={assignment.data} />
}

function TagAssignmentForm({ assignment }: { assignment: TagAssignment }) {
  const update = useUpdateTagAssignment()
  const [instructions, setInstructions] = useState(assignment.instructions)
  const ids = { mode: useId(), rule: useId(), ruleHint: useId(), limit: useId() }
  const dirty = instructions.trim() !== assignment.instructions.trim()
  const mode = MODES.find((option) => option.value === assignment.mode)

  function saveRule() {
    update.mutate(
      { instructions: instructions.trim() },
      { onSuccess: (updated) => setInstructions(updated.instructions) },
    )
  }

  return (
    <section className={styles.config} aria-label="Atribuição automática de tags">
      <Switch checked={assignment.auto_fill} onChange={(auto_fill) => update.mutate({ auto_fill })} disabled={update.isPending}>
        Atribuir tags automaticamente depois da transcrição
      </Switch>

      <div className="field">
        <label htmlFor={ids.rule}>Regra geral</label>
        <textarea
          id={ids.rule}
          className={`input ${styles.rule}`}
          value={instructions}
          maxLength={4000}
          aria-describedby={ids.ruleHint}
          onChange={(event) => setInstructions(event.target.value)}
        />
        <span id={ids.ruleHint} className="field-hint">
          Vale para todas as tags: quantas usar, como escrever, o que evitar. O que cada tag significa fica na
          descrição dela.
        </span>
        <div className={styles.ruleActions}>
          <button type="button" className="btn btn-secondary btn-sm" onClick={saveRule} disabled={!dirty || update.isPending}>
            Salvar
          </button>
        </div>
      </div>

      <fieldset className={`field ${styles.fieldset}`}>
        <legend className="field-label">Quais tags o agente usa</legend>
        <div className="seg">
          {MODES.map((option) => (
            <label key={option.value} className="seg-opt">
              <input
                type="radio"
                name={ids.mode}
                value={option.value}
                checked={assignment.mode === option.value}
                onChange={() => update.mutate({ mode: option.value })}
              />
              {option.label}
            </label>
          ))}
        </div>
        <span className="field-hint">{mode?.hint}</span>
      </fieldset>

      {assignment.mode === 'auto' && (
        <div className="field">
          <label htmlFor={ids.limit}>Tags novas por gravação</label>
          <select
            id={ids.limit}
            className={`input ${styles.limit}`}
            value={assignment.new_limit}
            onChange={(event) => update.mutate({ new_limit: Number(event.target.value) })}
          >
            {LIMITS.map((limit) => (
              <option key={limit} value={limit}>
                {limit === 1 ? 'Até 1 tag nova' : `Até ${limit} tags novas`}
              </option>
            ))}
          </select>
          <span className={`field-hint ${styles.catalog}`}>
            <span>
              O agente sempre prefere reusar uma tag cadastrada e casa variações (maiúsculas, acentos, plural). Ele
              para de criar tags quando o cadastro chega a {assignment.catalog_limit}.
            </span>
            <span className="tabular">{`${assignment.catalog_count} de ${assignment.catalog_limit} tags`}</span>
          </span>
        </div>
      )}

      {update.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(update.error)}
        </p>
      )}
    </section>
  )
}
