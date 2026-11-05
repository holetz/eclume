import { Fragment, useId, useState, type FormEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { Schemas } from '../../api/client'
import { errorMessage } from '../../api/problem'
import { AdminPageHead } from './AdminPageHead'
import styles from './Admin.module.css'
import { activeLocale } from '../../i18n'
import { DENOISE_METHODS, fieldErrorsOf, labelOf, lastChangeText, numberFormat } from './labels'
import { useAdminSettings, useUpdateSettings } from './queries'
import { Switch } from '../../shared/Switch'

type Settings = Schemas['AdminSettings']
type Preprocessing = Schemas['PreprocessingSettings']
type Step = 'split_channels' | 'denoise' | 'loudnorm' | 'trim_silence'

const FORM_ID = 'admin-audio'
const decimal = { format: (value: number) => numberFormat('decimal', { maximumFractionDigits: 2 }).format(value) }

// The numeric parameters, within the contract's `PreprocessingSettings` limits. The field keeps the
// typed text, so the admin can delete and retype; the number comes out at save time.
const LIMITS = {
  'loudnorm.target_lufs': { key: 'targetLufs', min: -30, max: -10, step: 0.5 },
  'loudnorm.true_peak_db': { key: 'truePeak', min: -9, max: 0, step: 0.1 },
  'loudnorm.lra': { key: 'lra', min: 1, max: 20, step: 0.5 },
  'trim_silence.min_silence_s': { key: 'minSilence', min: 1, max: 30, step: 0.5 },
  'trim_silence.threshold_db': { key: 'threshold', min: -80, max: -20, step: 1 },
} as const
type NumberField = keyof typeof LIMITS

function numbersOf(preprocessing: Preprocessing): Record<NumberField, string> {
  const { loudnorm, trim_silence: trim } = preprocessing
  return {
    'loudnorm.target_lufs': String(loudnorm.target_lufs),
    'loudnorm.true_peak_db': String(loudnorm.true_peak_db),
    'loudnorm.lra': String(loudnorm.lra),
    'trim_silence.min_silence_s': String(trim.min_silence_s),
    'trim_silence.threshold_db': String(trim.threshold_db),
  }
}

function inLimits(field: NumberField, value: string): boolean {
  const number = Number(value)
  return value.trim() !== '' && Number.isFinite(number) && number >= LIMITS[field].min && number <= LIMITS[field].max
}

/** The audio treatment steps before transcription; the order is fixed (holetz/eclume#33). */
export function AudioPage() {
  const { t } = useTranslation('admin')
  const settings = useAdminSettings()
  if (settings.data) return <AudioForm settings={settings.data} />
  return (
    <>
      <AdminPageHead title={t('audio.title')} />
      {settings.isError ? (
        <p className="alert alert-error" role="alert">
          {errorMessage(settings.error)}
        </p>
      ) : (
        <p role="status">{t('settings.loading')}</p>
      )}
    </>
  )
}

function AudioForm({ settings }: { settings: Settings }) {
  const { t } = useTranslation('admin')
  const update = useUpdateSettings()
  const saved = settings.preprocessing
  const [enabled, setEnabled] = useState<Record<Step, boolean>>({
    split_channels: saved.split_channels.enabled,
    denoise: saved.denoise.enabled,
    loudnorm: saved.loudnorm.enabled,
    trim_silence: saved.trim_silence.enabled,
  })
  const [method, setMethod] = useState(saved.denoise.method)
  const [strength, setStrength] = useState(saved.denoise.strength)
  const [numbers, setNumbers] = useState(() => numbersOf(saved))
  const [open, setOpen] = useState<Step | null>(null)
  const [sent, setSent] = useState<string | null>(null)
  const ids = { method: useId(), strength: useId(), fields: useId() }

  const valid = (Object.keys(LIMITS) as NumberField[]).every((field) => inLimits(field, numbers[field]))
  const body: Preprocessing = {
    split_channels: { enabled: enabled.split_channels },
    denoise: { enabled: enabled.denoise, method, strength },
    loudnorm: {
      enabled: enabled.loudnorm,
      target_lufs: Number(numbers['loudnorm.target_lufs']),
      true_peak_db: Number(numbers['loudnorm.true_peak_db']),
      lra: Number(numbers['loudnorm.lra']),
    },
    trim_silence: {
      enabled: enabled.trim_silence,
      min_silence_s: Number(numbers['trim_silence.min_silence_s']),
      threshold_db: Number(numbers['trim_silence.threshold_db']),
    },
  }
  const json = JSON.stringify(body)
  const { split_channels, denoise, loudnorm, trim_silence } = saved
  const changed = json !== JSON.stringify({ split_channels, denoise, loudnorm, trim_silence })
  const canSave = valid && changed && !update.isPending
  const serverErrors = fieldErrorsOf(update.error)

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!canSave) return
    setSent(null)
    update.mutate({ preprocessing: body }, { onSuccess: () => setSent(json) })
  }

  function numberField(field: NumberField) {
    const limits = LIMITS[field]
    const id = `${ids.fields}-${field}`
    const error = !inLimits(field, numbers[field])
      ? t('audio.between', { min: decimal.format(limits.min), max: decimal.format(limits.max) })
      : serverErrors[`preprocessing.${field}`]
    return (
      <div className="field" key={field}>
        <label htmlFor={id}>{t(`audio.limit.${limits.key}`)}</label>
        <input
          id={id}
          className="input"
          type="number"
          min={limits.min}
          max={limits.max}
          step={limits.step}
          value={numbers[field]}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-erro` : undefined}
          onChange={(e) => setNumbers((current) => ({ ...current, [field]: e.target.value }))}
        />
        {error && (
          <span id={`${id}-erro`} className={`field-hint ${styles.error}`}>
            {error}
          </span>
        )}
      </div>
    )
  }

  const toggle = (step: Step) => (value: boolean) => setEnabled((current) => ({ ...current, [step]: value }))
  const settingsButton = (step: Step, title: string) => (
    <button
      type="button"
      className="btn btn-ghost btn-sm"
      aria-expanded={open === step}
      aria-controls={`${FORM_ID}-${step}`}
      aria-label={t('audio.settingsOf', { title: title.toLocaleLowerCase(activeLocale()) })}
      onClick={() => setOpen(open === step ? null : step)}
    >
      {t('audio.settings')}
    </button>
  )

  // The order the worker runs in (preprocess.py): channels, noise, loudness, 16 kHz mono, silence.
  const steps: { key: Step | 'resample'; title: string; summary: string; panel?: ReactNode }[] = [
    {
      key: 'split_channels',
      title: t('audio.split'),
      summary: t('audio.splitSummary'),
    },
    {
      key: 'denoise',
      title: t('audio.denoise'),
      summary: t('audio.denoiseSummary', { method: labelOf(DENOISE_METHODS, method), strength: decimal.format(strength) }),
      panel: (
        <>
          <div className="field">
            <span id={ids.method} className={styles.label}>
              {t('audio.method')}
            </span>
            <div className="seg" role="radiogroup" aria-labelledby={ids.method}>
              {DENOISE_METHODS.map((option) => (
                <label key={option.value} className="seg-opt">
                  <input
                    type="radio"
                    name={ids.method}
                    value={option.value}
                    checked={method === option.value}
                    onChange={() => setMethod(option.value as Preprocessing['denoise']['method'])}
                  />
                  {option.label}
                </label>
              ))}
            </div>
            <span className="field-hint">{t('audio.methodHint')}</span>
          </div>
          <div className="field">
            <label htmlFor={ids.strength}>{t('audio.strength', { value: decimal.format(strength) })}</label>
            <input
              id={ids.strength}
              className={styles.range}
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={strength}
              onChange={(e) => setStrength(Number(e.target.value))}
            />
          </div>
        </>
      ),
    },
    {
      key: 'loudnorm',
      title: t('audio.loudnorm'),
      summary: t('audio.loudnormSummary', { value: decimal.format(body.loudnorm.target_lufs) }),
      panel: (
        <div className={styles.fields3}>
          {numberField('loudnorm.target_lufs')}
          {numberField('loudnorm.true_peak_db')}
          {numberField('loudnorm.lra')}
        </div>
      ),
    },
    { key: 'resample', title: t('audio.resample'), summary: t('audio.resampleSummary') },
    {
      key: 'trim_silence',
      title: t('audio.trim'),
      summary: t('audio.trimSummary', { value: decimal.format(body.trim_silence.min_silence_s) }),
      panel: (
        <>
          <div className={styles.fields3}>
            {numberField('trim_silence.min_silence_s')}
            {numberField('trim_silence.threshold_db')}
          </div>
          <span className="field-hint">{t('audio.trimHint')}</span>
        </>
      ),
    },
  ]

  return (
    <>
      <AdminPageHead
        title={t('audio.title')}
        actions={
          <button type="submit" form={FORM_ID} className="btn btn-primary" disabled={!canSave}>
            {update.isPending ? t('settings.saving') : t('settings.save')}
          </button>
        }
      />
      <form id={FORM_ID} className={styles.audioForm} onSubmit={submit} aria-label={t('audio.title')}>
        <p className={`text-muted ${styles.lede}`}>
          {t('audio.lede')}
        </p>
        <ol className={`order-list ${styles.orderList}`} aria-label={t('audio.steps')}>
          {steps.map((step, index) => (
            <Fragment key={step.key}>
              <li>
                <span className="order-num">{String(index + 1).padStart(2, '0')}</span>
                <span>
                  <strong>{step.title}</strong>
                  <br />
                  <span className={`text-muted ${styles.note}`}>{step.summary}</span>
                </span>
                <span className={styles.row}>
                  {step.key === 'resample' ? (
                    <span className={`text-muted ${styles.small}`}>{t('audio.alwaysOn')}</span>
                  ) : (
                    <>
                      {step.panel && settingsButton(step.key, step.title)}
                      <Switch checked={enabled[step.key]} onChange={toggle(step.key)} label={step.title} />
                    </>
                  )}
                </span>
              </li>
              {step.panel && open === step.key && (
                <li className={styles.stepPanel}>
                  <div id={`${FORM_ID}-${step.key}`} className="panel">
                    {step.panel}
                  </div>
                </li>
              )}
            </Fragment>
          ))}
        </ol>
        {update.isError && (
          <p className="alert alert-error" role="alert">
            {errorMessage(update.error)}
          </p>
        )}
        <p role="status" className="text-muted">
          {sent === json ? t('settings.saved') : ''}
        </p>
        <p className={styles.meta}>{lastChangeText(settings)}</p>
      </form>
      <RetentionCeiling settings={settings} />
    </>
  )
}

const MAX_RETENTION_DAYS = 3650

/** The audio retention ceiling: limits what each account chooses and never deletes the audio of anyone who did not turn retention on. */
function RetentionCeiling({ settings }: { settings: Settings }) {
  const { t } = useTranslation('admin')
  const update = useUpdateSettings()
  const id = useId()
  const saved = settings.retention.audio_max_days
  const [enabled, setEnabled] = useState(saved !== null)
  const [value, setValue] = useState(String(saved ?? 365))

  const days = Number(value)
  const valid = Number.isInteger(days) && days >= 1 && days <= MAX_RETENTION_DAYS
  const chosen = enabled ? days : null
  const canSave = (!enabled || valid) && chosen !== saved && !update.isPending
  const serverError = fieldErrorsOf(update.error)['retention.audio_max_days']

  function submit(event: FormEvent) {
    event.preventDefault()
    if (canSave) update.mutate({ retention: { audio_max_days: chosen } })
  }

  return (
    <form className={`panel ${styles.audioForm}`} onSubmit={submit} aria-label={t('audio.retention')}>
      <h2 className={styles.note}>{t('audio.retention')}</h2>
      <p className={`text-muted ${styles.lede}`}>
        {t('audio.retentionLede')}
      </p>
      <Switch checked={enabled} onChange={setEnabled}>
        {t('audio.limitRetention')}
      </Switch>
      {enabled && (
        <div className="field">
          <label htmlFor={id}>{t('audio.ceiling')}</label>
          <input
            id={id}
            className="input"
            type="number"
            min={1}
            max={MAX_RETENTION_DAYS}
            step={1}
            value={value}
            aria-invalid={!valid || serverError ? true : undefined}
            onChange={(e) => setValue(e.target.value)}
          />
          {(!valid || serverError) && (
            <span className={`field-hint ${styles.error}`}>{serverError ?? t('audio.ceilingBetween', { max: MAX_RETENTION_DAYS })}</span>
          )}
        </div>
      )}
      {update.isError && !serverError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(update.error)}
        </p>
      )}
      {update.isSuccess && chosen === saved && (
        <p role="status" className="text-muted">
          {t('audio.ceilingSaved')}
        </p>
      )}
      <div>
        <button type="submit" className="btn btn-primary" disabled={!canSave}>
          {t('audio.apply')}
        </button>
      </div>
    </form>
  )
}
