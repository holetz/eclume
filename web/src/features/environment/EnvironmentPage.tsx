import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useHelpTopic } from '../../app/help'
import { PageHead } from '../../app/PageHead'
import {
  DEFAULT_WORK_HOURS,
  enableNotifyOutcomes,
  notifyOutcomesOn,
  notifyPermission,
  readDensity,
  readLibraryOpening,
  readMotion,
  readWorkHours,
  resetEnvironment,
  saveDensity,
  saveLibraryOpening,
  saveMotion,
  saveNotifyOutcomes,
  saveWorkHours,
  type DensityPreference,
  type LibraryOpening,
  type MotionPreference,
  type WorkHours,
} from '../../app/preferences'
import { applyThemePreference, readThemePreference, type ThemePreference } from '../../app/theme'
import { Switch } from '../../shared/Switch'
import styles from './Environment.module.css'

interface Option<T extends string> {
  value: T
  label: string
}

const THEMES: readonly ThemePreference[] = ['system', 'light', 'dark']
const DENSITIES: readonly DensityPreference[] = ['comfortable', 'compact']
const MOTIONS: readonly MotionPreference[] = ['system', 'reduce']
const OPENINGS: readonly LibraryOpening[] = ['ultima', 'semana', 'mes', 'lista']

const hourLabel = (hour: number) => `${String(hour).padStart(2, '0')}:00`

/** A DS segmented control with a label and a hint. */
function Segmented<T extends string>({
  label,
  hint,
  options,
  value,
  onChange,
}: {
  label: string
  hint?: string
  options: Option<T>[]
  value: T
  onChange: (value: T) => void
}) {
  const id = useId()
  return (
    <div className="field">
      <span className="field-label" id={`${id}-label`}>
        {label}
      </span>
      <div
        className={`seg ${styles.seg}`}
        role="radiogroup"
        aria-labelledby={`${id}-label`}
        aria-describedby={hint ? `${id}-hint` : undefined}
      >
        {options.map((option) => (
          <label key={option.value} className="seg-opt">
            <input
              type="radio"
              name={id}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
            />
            {option.label}
          </label>
        ))}
      </div>
      {hint && (
        <span className="field-hint" id={`${id}-hint`}>
          {hint}
        </span>
      )}
    </div>
  )
}

/** Settings for this browser: appearance, agenda and shortcuts. Nothing here goes to the account or the server. */
export function EnvironmentPage() {
  useHelpTopic('ambiente')
  const { t } = useTranslation('environment')
  const id = useId()
  const [theme, setTheme] = useState(readThemePreference)
  const [density, setDensity] = useState(readDensity)
  const [motion, setMotion] = useState(readMotion)
  const [opening, setOpening] = useState(readLibraryOpening)
  const [work, setWork] = useState(readWorkHours)
  const [notify, setNotify] = useState(notifyOutcomesOn)
  const [blocked, setBlocked] = useState(() => notifyPermission() === 'denied')
  const [notice, setNotice] = useState<string | null>(null)

  function changeWork(next: WorkHours) {
    setWork(next)
    saveWorkHours(next)
    setNotice(null)
  }

  function restore() {
    resetEnvironment()
    applyThemePreference('system')
    setTheme('system')
    setDensity(readDensity())
    setMotion(readMotion())
    setOpening(readLibraryOpening())
    setWork(readWorkHours())
    setNotify(false)
    setNotice(t('restored'))
  }

  async function changeNotify(on: boolean) {
    setNotice(null)
    if (!on) {
      saveNotifyOutcomes(false)
      setNotify(false)
      return
    }
    const permission = await enableNotifyOutcomes()
    setNotify(permission === 'granted')
    setBlocked(permission === 'denied')
  }

  const unsupported = notifyPermission() === 'unsupported'
  const options = <T extends string>(values: readonly T[], label: (value: T) => string): Option<T>[] =>
    values.map((value) => ({ value, label: label(value) }))
  const shortcuts: { keys: string[]; action: string }[] = [
    { keys: ['?'], action: t('keys.help') },
    { keys: ['Esc'], action: t('keys.close') },
    { keys: ['Ctrl', t('keys.wheel')], action: t('keys.zoom') },
  ]

  return (
    <section className={styles.page}>
      <PageHead kicker={t('kicker')} title={t('title')} />
      <p className={styles.lead}>{t('lead')}</p>

      <div className={styles.sections}>
        <section className="panel" aria-labelledby={`${id}-look`}>
          <h4 id={`${id}-look`}>{t('look.title')}</h4>
          <Segmented
            label={t('look.theme')}
            options={options(THEMES, (value) => t(`look.themes.${value}`))}
            value={theme}
            onChange={(value) => {
              setTheme(value)
              applyThemePreference(value)
              setNotice(null)
            }}
          />
          <Segmented
            label={t('look.density')}
            hint={t('look.densityHint')}
            options={options(DENSITIES, (value) => t(`look.densities.${value}`))}
            value={density}
            onChange={(value) => {
              setDensity(value)
              saveDensity(value)
              setNotice(null)
            }}
          />
          <Segmented
            label={t('look.motion')}
            hint={t('look.motionHint')}
            options={options(MOTIONS, (value) => t(`look.motions.${value}`))}
            value={motion}
            onChange={(value) => {
              setMotion(value)
              saveMotion(value)
              setNotice(null)
            }}
          />
        </section>

        <section className="panel" aria-labelledby={`${id}-agenda`}>
          <h4 id={`${id}-agenda`}>{t('agenda.title')}</h4>
          <fieldset className={styles.hours} aria-describedby={`${id}-work-hint`}>
            <legend className="field-label">{t('agenda.workHours')}</legend>
            <div className={styles.hourPair}>
              <label className="field">
                <span className="field-label">{t('agenda.start')}</span>
                <select
                  className="input"
                  value={work.start}
                  onChange={(event) => {
                    const start = Number(event.target.value)
                    changeWork({ start, end: Math.max(work.end, start + 1) })
                  }}
                >
                  {Array.from({ length: 24 }, (_, hour) => (
                    <option key={hour} value={hour}>
                      {hourLabel(hour)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="field-label">{t('agenda.end')}</span>
                <select
                  className="input"
                  value={work.end}
                  onChange={(event) => {
                    const end = Number(event.target.value)
                    changeWork({ start: Math.min(work.start, end - 1), end })
                  }}
                >
                  {Array.from({ length: 24 }, (_, index) => index + 1).map((hour) => (
                    <option key={hour} value={hour}>
                      {hourLabel(hour)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <span className="field-hint" id={`${id}-work-hint`}>
              {t('agenda.workHint', {
                start: hourLabel(DEFAULT_WORK_HOURS.start),
                end: hourLabel(DEFAULT_WORK_HOURS.end),
              })}
            </span>
          </fieldset>
          <Segmented
            label={t('agenda.opening')}
            hint={t('agenda.openingHint')}
            options={options(OPENINGS, (value) => t(`agenda.openings.${value}`))}
            value={opening}
            onChange={(value) => {
              setOpening(value)
              saveLibraryOpening(value)
              setNotice(null)
            }}
          />
        </section>

        <section className="panel" aria-labelledby={`${id}-notices`}>
          <h4 id={`${id}-notices`}>{t('notices.title')}</h4>
          <Switch checked={notify} disabled={unsupported} onChange={(on) => void changeNotify(on)}>
            {t('notices.toggle')}
          </Switch>
          <span className="field-hint">
            {unsupported
              ? t('notices.unsupported')
              : blocked
                ? t('notices.blocked')
                : t('notices.hint')}
          </span>
        </section>

        <section className="panel" aria-labelledby={`${id}-keys`}>
          <h4 id={`${id}-keys`}>{t('keys.title')}</h4>
          <dl className={styles.shortcuts}>
            {shortcuts.map((shortcut) => (
              <div key={shortcut.action} className={styles.shortcut}>
                <dt>
                  {shortcut.keys.map((key, index) => (
                    <span key={key}>
                      {index > 0 && ' + '}
                      <kbd className={styles.kbd}>{key}</kbd>
                    </span>
                  ))}
                </dt>
                <dd>{shortcut.action}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>

      <div className={styles.footer}>
        <button type="button" className="btn btn-secondary" onClick={restore}>
          {t('restore')}
        </button>
        {notice && (
          <span role="status" className="text-muted">
            {notice}
          </span>
        )}
      </div>
    </section>
  )
}
