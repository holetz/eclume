import { useId, useState } from 'react'
import { errorMessage } from '../../api/problem'
import { Switch } from '../../shared/Switch'
import styles from './People.module.css'
import { useUpdateVoiceAssignment, useVoiceAssignment, type VoiceAssignment } from './queries'

const MIN = 0.5
const MAX = 0.99
const percent = new Intl.NumberFormat('pt-BR', {
  style: 'percent',
  maximumFractionDigits: 0,
})

/** Liga o locutor à pessoa sozinho, pela voz, a partir de uma pontuação que o usuário escolhe. */
export function AutoAssignCard() {
  const assignment = useVoiceAssignment()
  // Sem identificação por voz na plataforma, a preferência não tem efeito: nem aparece.
  if (!assignment.data?.platform_enabled) return null
  return <AutoAssignForm assignment={assignment.data} />
}

function AutoAssignForm({ assignment }: { assignment: VoiceAssignment }) {
  const update = useUpdateVoiceAssignment()
  const [threshold, setThreshold] = useState(assignment.threshold)
  const sliderId = useId()
  const hintId = useId()

  return (
    <section className={styles.autoAssign} aria-label="Atribuição automática de locutores">
      <Switch
        checked={assignment.enabled}
        onChange={(enabled) => update.mutate({ enabled })}
        disabled={update.isPending}
      >
        Ligar os locutores às pessoas automaticamente pela voz
      </Switch>
      <div className="field">
        <label htmlFor={sliderId}>
          Pontuação mínima: <strong>{percent.format(threshold)}</strong>
        </label>
        <input
          id={sliderId}
          type="range"
          min={MIN}
          max={MAX}
          step={0.01}
          value={threshold}
          disabled={!assignment.enabled}
          aria-describedby={hintId}
          onChange={(event) => setThreshold(Number(event.target.value))}
          onPointerUp={() => threshold !== assignment.threshold && update.mutate({ threshold })}
          onKeyUp={() => threshold !== assignment.threshold && update.mutate({ threshold })}
          onBlur={() => threshold !== assignment.threshold && update.mutate({ threshold })}
        />
        <p id={hintId} className="text-muted">
          Nas próximas gravações, o locutor cuja voz passa dessa pontuação recebe o nome da pessoa antes do resumo.
          Quanto mais alta, menos erros e mais locutores ficam só como sugestão. Sempre dá para desfazer na página da
          gravação.
        </p>
      </div>
      {update.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(update.error)}
        </p>
      )}
    </section>
  )
}
