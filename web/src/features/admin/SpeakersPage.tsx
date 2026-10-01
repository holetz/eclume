import { useId, useState, type FormEvent } from 'react'
import type { Schemas } from '../../api/client'
import { errorMessage } from '../../api/problem'
import { ConfirmDialog } from '../../app/ConfirmDialog'
import { AdminPageHead } from './AdminPageHead'
import styles from './Admin.module.css'
import { lastChangeText, SECRET_INFO, SPEAKER_PRESETS, speakerPreset } from './labels'
import { useAdminSettings, usePlatformSecret, useSecrets, useUpdateSettings } from './queries'
import { SecretField } from './SecretField'
import { Switch } from '../../shared/Switch'

type Settings = Schemas['AdminSettings']
type Secret = Schemas['SecretList']['items'][number]

const FORM_ID = 'admin-locutores'
const HF_TOKEN = 'hf_token'
const THRESHOLD_MIN = 0.5
const decimal = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** Separação de locutores (pyannote, com o token do Hugging Face) e a identificação pelas vozes. */
export function SpeakersPage() {
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
      <AdminPageHead title="Locutores" />
      {error ? (
        <p className="alert alert-error" role="alert">
          {errorMessage(error)}
        </p>
      ) : (
        <p role="status">Carregando a configuração…</p>
      )}
    </>
  )
}

function SpeakersForm({ settings, hf }: { settings: Settings; hf: Secret }) {
  const update = useUpdateSettings()
  const secret = usePlatformSecret(HF_TOKEN)
  const saved = { diarization: settings.diarization, voice: settings.voice_identification }
  const [diarize, setDiarize] = useState(saved.diarization.enabled)
  const [preset, setPreset] = useState(() => speakerPreset(saved.diarization).value)
  const [identify, setIdentify] = useState(saved.voice.enabled && saved.diarization.enabled)
  const [threshold, setThreshold] = useState(saved.voice.suggestion_threshold)
  const [confirming, setConfirming] = useState(false)
  // O que foi salvo por último: o aviso vale até o form mudar de novo.
  const [sent, setSent] = useState<string | null>(null)
  const ids = { speakers: useId(), threshold: useId() }

  // "Personalizado" só existe enquanto o valor salvo não bate com as opções do DS.
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
    // A identificação compara os locutores que a separação produz: sem ela, desliga junto.
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
        title="Locutores"
        actions={
          <button type="submit" form={FORM_ID} className="btn btn-primary" disabled={!canSave}>
            {update.isPending ? 'Salvando…' : 'Salvar'}
          </button>
        }
      />
      <form id={FORM_ID} className={styles.wideForm} onSubmit={submit} aria-label="Configuração de locutores">
        <section className={styles.stack} aria-labelledby={`${FORM_ID}-separacao`}>
          <h2 id={`${FORM_ID}-separacao`} className={styles.sectionTitle}>
            1 · Separação
          </h2>
          <Switch checked={diarize} onChange={changeDiarize}>
            Separar os locutores com pyannote
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
              Sem o token, a transcrição sai com um locutor só.
            </p>
          )}
          <div className="field">
            <span id={ids.speakers} className={styles.label}>
              Pessoas esperadas
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
            2 · Identificação
          </h2>
          <p className={`text-muted ${styles.note}`}>
            Compara cada locutor separado com as amostras de voz guardadas. Desliga se a separação estiver desligada.
          </p>
          <Switch checked={identify} onChange={setIdentify} disabled={!diarize}>
            Sugerir quem está falando pelas amostras de voz
          </Switch>
          <div className="field">
            <label htmlFor={ids.threshold}>Limiar de correspondência · {decimal.format(threshold)}</label>
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
              <span>Mais sugestões</span>
              <span>Menos sugestões, mais certeiras</span>
            </div>
          </div>
          <p className={`text-muted ${styles.note}`}>
            Cada sugestão só vale depois que o usuário aceita. O consentimento é o do aviso que todo usuário aceita no
            cadastro.
          </p>
        </section>
        {update.isError && (
          <p className="alert alert-error" role="alert">
            {errorMessage(update.error)}
          </p>
        )}
        <p role="status" className="text-muted">
          {sent === JSON.stringify(body) ? 'Configuração salva.' : ''}
        </p>
        <p className={styles.meta}>{lastChangeText(settings)}</p>
      </form>
      {confirming && (
        <ConfirmDialog
          title="Desligar a identificação por voz?"
          confirmLabel="Desligar e salvar"
          busy={update.isPending}
          onConfirm={save}
          onCancel={() => setConfirming(false)}
        >
          Desligar apaga todas as impressões de voz da plataforma e as sugestões pendentes. As pessoas e as amostras
          confirmadas ficam, e as impressões são refeitas ao religar.
        </ConfirmDialog>
      )}
    </>
  )
}
