// The library's First steps card. The steps come from what the API already delivers (the account has a
// recording, the account has a person) and, the one about reviewing the agenda types, from this browser; the dismissal
// is also from this browser, like the Environment preferences.
import { Check } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { dismissFirstSteps, readAgendaTypesSeen, readFirstStepsDismissed } from '../../app/preferences'
import styles from './FirstSteps.module.css'
import { useHasAnyRecording } from './anyRecording'
import { useHasAnyPerson } from './queries'

export function FirstSteps({ onImport }: { onImport: () => void }) {
  const [dismissed, setDismissed] = useState(readFirstStepsDismissed)
  const recording = useHasAnyRecording(!dismissed)
  const person = useHasAnyPerson(!dismissed)
  if (dismissed || recording.data === undefined || person.data === undefined) return null

  const agendaTypes = readAgendaTypesSeen()
  if (recording.data && agendaTypes && person.data) return null

  function dismiss() {
    dismissFirstSteps()
    setDismissed(true)
  }

  return (
    <section className={`card ${styles.card}`} aria-labelledby="primeiros-passos">
      <div className={styles.head}>
        <h2 id="primeiros-passos">Primeiros passos</h2>
        <button type="button" className="btn btn-ghost" onClick={dismiss}>
          Dispensar
        </button>
      </div>
      <ol className={styles.steps}>
        <Step done={recording.data} title="Traga a primeira gravação">
          <button type="button" className={styles.linkButton} onClick={onImport}>
            Importe um arquivo
          </button>
          , grave com o <Link to="/app-desktop">app desktop</Link> ou pelo <Link to="/app-movel">app do celular</Link>.
        </Step>
        <Step done={agendaTypes} title="Confira os tipos de agenda">
          Eles dão o título e o modelo do resumo de cada reunião: <Link to="/config/agendas">abrir Tipos de agenda</Link>.
        </Step>
        <Step done={person.data} title="Ligue um locutor a uma pessoa">
          Na transcrição de uma gravação, escolha quem é cada locutor; a pessoa entra em{' '}
          <Link to="/pessoas">Pessoas</Link>.
        </Step>
      </ol>
    </section>
  )
}

function Step({ done, title, children }: { done: boolean; title: string; children: ReactNode }) {
  return (
    <li className={styles.step} data-done={done || undefined}>
      <span className={styles.mark} aria-hidden>
        {done && <Check size={14} />}
      </span>
      <div>
        <strong>
          {title}
          {done && <span className="visually-hidden"> (feito)</span>}
        </strong>
        <p className="text-muted">{children}</p>
      </div>
    </li>
  )
}
