import { useId, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { errorMessage } from '../../api/problem'
import { activeLocale } from '../../i18n'
import { Switch } from '../../shared/Switch'
import styles from './People.module.css'
import { useUpdateVoiceAssignment, useVoiceAssignment, type VoiceAssignment } from './queries'

const MIN = 0.5
const MAX = 0.99
const percent = (value: number) =>
  new Intl.NumberFormat(activeLocale(), { style: 'percent', maximumFractionDigits: 0 }).format(value)

/** Links the speaker to the person on its own, by voice, from a score the user chooses. */
export function AutoAssignCard() {
  const assignment = useVoiceAssignment()
  // With no voice identification on the platform, the preference has no effect: it does not even show.
  if (!assignment.data?.platform_enabled) return null
  if (!assignment.data.keep_samples) return <NoSamplesNotice />
  return <AutoAssignForm assignment={assignment.data} />
}

/** The account does not keep voice samples: nothing is linked or suggested by voice. */
function NoSamplesNotice() {
  const { t } = useTranslation('people')
  return (
    <section className={styles.autoAssign} aria-label={t('auto.label')}>
      <p className="alert alert-info" role="status">
        <Trans t={t} i18nKey="auto.noSamples" components={{ account: <Link to="/config/conta" /> }} />
      </p>
    </section>
  )
}

function AutoAssignForm({ assignment }: { assignment: VoiceAssignment }) {
  const { t } = useTranslation('people')
  const update = useUpdateVoiceAssignment()
  const [threshold, setThreshold] = useState(assignment.threshold)
  const sliderId = useId()
  const hintId = useId()

  return (
    <section className={styles.autoAssign} aria-label={t('auto.label')}>
      <Switch
        checked={assignment.enabled}
        onChange={(enabled) => update.mutate({ enabled })}
        disabled={update.isPending}
      >
        {t('auto.switch')}
      </Switch>
      <div className="field">
        <label htmlFor={sliderId}>
          <Trans t={t} i18nKey="auto.threshold" values={{ score: percent(threshold) }} components={{ b: <strong /> }} />
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
          {t('auto.hint')}
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
