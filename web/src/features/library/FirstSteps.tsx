// The library's First steps card. The steps come from what the API already delivers (the account has a
// recording, the account has a person) and, the one about reviewing the agenda types, from this browser; the dismissal
// is also from this browser, like the Environment preferences.
import { Check } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { dismissFirstSteps, readAgendaTypesSeen, readFirstStepsDismissed } from '../../app/preferences'
import styles from './FirstSteps.module.css'
import { useHasAnyRecording } from './anyRecording'
import { useHasAnyPerson } from './queries'

export function FirstSteps({ onImport }: { onImport: () => void }) {
  const { t } = useTranslation('library')
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
        <h2 id="primeiros-passos">{t('firstSteps.title')}</h2>
        <button type="button" className="btn btn-ghost" onClick={dismiss}>
          {t('firstSteps.dismiss')}
        </button>
      </div>
      <ol className={styles.steps}>
        <Step done={recording.data} title={t('firstSteps.recordingTitle')}>
          <Trans
            t={t}
            i18nKey="firstSteps.recording"
            components={{
              import: <button type="button" className={styles.linkButton} onClick={onImport} />,
              desktop: <Link to="/app-desktop" />,
              mobile: <Link to="/app-movel" />,
            }}
          />
        </Step>
        <Step done={agendaTypes} title={t('firstSteps.agendaTypesTitle')}>
          <Trans t={t} i18nKey="firstSteps.agendaTypes" components={{ agendas: <Link to="/config/agendas" /> }} />
        </Step>
        <Step done={person.data} title={t('firstSteps.personTitle')}>
          <Trans t={t} i18nKey="firstSteps.person" components={{ people: <Link to="/pessoas" /> }} />
        </Step>
      </ol>
    </section>
  )
}

function Step({ done, title, children }: { done: boolean; title: string; children: ReactNode }) {
  const { t } = useTranslation('library')
  return (
    <li className={styles.step} data-done={done || undefined}>
      <span className={styles.mark} aria-hidden>
        {done && <Check size={14} />}
      </span>
      <div>
        <strong>
          {title}
          {done && <span className="visually-hidden">{' '}{t('firstSteps.done')}</span>}
        </strong>
        <p className="text-muted">{children}</p>
      </div>
    </li>
  )
}
