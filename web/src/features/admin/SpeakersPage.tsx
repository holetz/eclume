import { useId, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { Schemas } from '../../api/client'
import { errorMessage } from '../../api/problem'
import { ConfirmDialog } from '../../app/ConfirmDialog'
import { AdminPageHead } from './AdminPageHead'
import styles from './Admin.module.css'
import { lastChangeText, numberFormat, SECRET_INFO, SPEAKER_PRESETS, speakerPreset } from './labels'
import { useAdminSettings, usePlatformSecret, useSecrets, useUpdateSettings } from './queries'
import { SecretField } from './SecretField'
import { Switch } from '../../shared/Switch'

type Settings = Schemas['AdminSettings']
type Secret = Schemas['SecretList']['items'][number]

const FORM_ID = 'admin-locutores'
const HF_TOKEN = 'hf_token'
const THRESHOLD_MIN = 0.5
const decimal = () => numberFormat('decimal2', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** Speaker diarization (pyannote, with the Hugging Face token) and identification by voice. */
export function SpeakersPage() {
  const { t } = useTranslation('admin')
  const settings = useAdminSettings()
  const secrets = useSecrets()
  if (settings.data && secrets.data) {
    const hf = secrets.data.items.find((secret) => secret.name === HF_TOKEN) ?? {
      name: HF_TOKEN,
      is_set: false,
      updated_at: null,
    }
    return <SpeakersForm settings={settings.data} hf={hf} />
  }
  const error = settings.error ?? secrets.error
  return (
    <>
      <AdminPageHead title={t('speakers.title')} />
      {error ? (
        <p className="alert alert-error" role="alert">
          {errorMessage(error)}
        </p>
      ) : (
        <p role="status">{t('settings.loading')}</p>
      )}
    </>
  )
}

function SpeakersForm({ settings, hf }: { settings: Settings; hf: Secret }) {
  const { t } = useTranslation('admin')
  const update = useUpdateSettings()
  const secret = usePlatformSecret(HF_TOKEN)
  const saved = { diarization: settings.diarization, voice: settings.voice_identification }
  const [diarize, setDiarize] = useState(saved.diarization.enabled)
  const [preset, setPreset] = useState(() => speakerPreset(saved.diarization).value)
  const [identify, setIdentify] = useState(saved.voice.enabled && saved.diarization.enabled)
  const [threshold, setThreshold] = useState(saved.voice.suggestion_threshold)
  const [confirming, setConfirming] = useState(false)
  // What was saved last: the notice holds until the form changes again.
  const [sent, setSent] = useState<string | null>(null)
  const ids = { speakers: useId(), threshold: useId() }

  // "Personalizado" only exists while the saved value matches none of the DS options.
  const savedPreset = speakerPreset(saved.diarization)
  const presets = savedPreset.custom ? [...SPEAKER_PRESETS, savedPreset] : SPEAKER_PRESETS
  const chosen = presets.find((option) => option.value === preset) ?? savedPreset

  const body = {
    diarization: { enabled: diarize, min_speakers: chosen.min, max_speakers: chosen.max },
    voice_identification: { enabled: identify, suggestion_threshold: threshold },
  }
  const changed =
    body.diarization.enabled !== saved.diarization.enabled ||
    body.diarization.min_speakers !== saved.diarization.min_speakers ||
    body.diarization.max_speakers !== saved.diarization.max_speakers ||
    body.voice_identification.enabled !== saved.voice.enabled ||
    body.voice_identification.suggestion_threshold !== saved.voice.suggestion_threshold
  const canSave = changed && !update.isPending

  function changeDiarize(value: boolean) {
    setDiarize(value)
    // Identification compares the speakers diarization produces: without it, it turns off too.
    if (!value) setIdentify(false)
  }

  function save() {
    setConfirming(false)
    const json = JSON.stringify(body)
    setSent(null)
    update.mutate(body, { onSuccess: () => setSent(json) })
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!canSave) return
    if (saved.voice.enabled && !identify) setConfirming(true)
    else save()
  }

  return (
    <>
      <AdminPageHead
        title={t('speakers.title')}
        actions={
          <button type="submit" form={FORM_ID} className="btn btn-primary" disabled={!canSave}>
            {update.isPending ? t('settings.saving') : t('settings.save')}
          </button>
        }
      />
      <form id={FORM_ID} className={styles.wideForm} onSubmit={submit} aria-label={t('speakers.form')}>
        <section className={styles.stack} aria-labelledby={`${FORM_ID}-separacao`}>
          <h2 id={`${FORM_ID}-separacao`} className={styles.sectionTitle}>
            {t('speakers.separation')}
          </h2>
          <Switch checked={diarize} onChange={changeDiarize}>
            {t('speakers.diarize')}
          </Switch>
          <SecretField
            label={SECRET_INFO[HF_TOKEN].label}
            isSet={hf.is_set}
            updatedAt={hf.updated_at}
            hint={SECRET_INFO[HF_TOKEN].hint}
            onSave={(value) => secret.save.mutateAsync(value)}
            onClear={() => secret.clear.mutateAsync()}
          />
          {diarize && !hf.is_set && (
            <p className="alert alert-warning" role="alert">
              {t('speakers.noToken')}
            </p>
          )}
          <div className="field">
            <span id={ids.speakers} className={styles.label}>
              {t('speakers.expected')}
            </span>
            <div className="seg" role="radiogroup" aria-labelledby={ids.speakers}>
              {presets.map((option) => (
                <label key={option.value} className="seg-opt">
                  <input
                    type="radio"
                    name={ids.speakers}
                    value={option.value}
                    checked={chosen.value === option.value}
                    disabled={!diarize}
                    onChange={() => setPreset(option.value)}
                  />
                  {option.label}
                </label>
              ))}
            </div>
          </div>
        </section>
        <section className={`${styles.stack} ${styles.divided}`} aria-labelledby={`${FORM_ID}-identificacao`}>
          <h2 id={`${FORM_ID}-identificacao`} className={styles.sectionTitle}>
            {t('speakers.identification')}
          </h2>
          <p className={`text-muted ${styles.note}`}>
            {t('speakers.identificationNote')}
          </p>
          <Switch checked={identify} onChange={setIdentify} disabled={!diarize}>
            {t('speakers.identify')}
          </Switch>
          <div className="field">
            <label htmlFor={ids.threshold}>{t('speakers.threshold', { value: decimal().format(threshold) })}</label>
            <input
              id={ids.threshold}
              className={styles.range}
              type="range"
              min={Math.min(THRESHOLD_MIN, saved.voice.suggestion_threshold)}
              max={0.99}
              step={0.01}
              value={threshold}
              disabled={!identify}
              onChange={(e) => setThreshold(Number(e.target.value))}
            />
            <div className="progress-row">
              <span>{t('speakers.more')}</span>
              <span>{t('speakers.fewer')}</span>
            </div>
          </div>
          <p className={`text-muted ${styles.note}`}>
            {t('speakers.consent')}
          </p>
        </section>
        {update.isError && (
          <p className="alert alert-error" role="alert">
            {errorMessage(update.error)}
          </p>
        )}
        <p role="status" className="text-muted">
          {sent === JSON.stringify(body) ? t('settings.saved') : ''}
        </p>
        <p className={styles.meta}>{lastChangeText(settings)}</p>
      </form>
      {confirming && (
        <ConfirmDialog
          title={t('speakers.offTitle')}
          confirmLabel={t('speakers.offConfirm')}
          busy={update.isPending}
          onConfirm={save}
          onCancel={() => setConfirming(false)}
        >
          {t('speakers.offBody')}
        </ConfirmDialog>
      )}
    </>
  )
}
