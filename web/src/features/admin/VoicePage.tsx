import { useId, useState, type FormEvent } from 'react'
import { type Schemas } from '../../api/client'
import { errorMessage } from '../../api/problem'
import { usePageTitle } from '../../app/usePageTitle'
import styles from './Admin.module.css'
import { useAdminSettings, useUpdateSettings } from './queries'
import { sectionTitle } from './sections'

type Settings = Schemas['AdminSettings']

/** Identificação por voz: o liga-desliga da plataforma (LGPD) e o limiar de sugestão. */
export function VoicePage() {
  usePageTitle(sectionTitle('voz'))
  const settings = useAdminSettings()
  return (
    <section className={styles.page} aria-labelledby="voz-titulo">
      <div className={styles.intro}>
        <h2 id="voz-titulo">Identificação por voz</h2>
        <p className="text-muted">
          O eclume pode sugerir quem é cada locutor comparando a voz com a das pessoas que o próprio usuário já
          confirmou. Voz é dado biométrico (LGPD): cada conta aceita, no cadastro, a responsabilidade de pedir o
          consentimento de quem grava, e nenhuma sugestão vira identificação sem alguém aceitar.
        </p>
      </div>
      {settings.isPending && <p role="status">Carregando a configuração…</p>}
      {settings.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(settings.error)}
        </p>
      )}
      {settings.data && <VoiceForm settings={settings.data} />}
    </section>
  )
}

function VoiceForm({ settings }: { settings: Settings }) {
  const voice = settings.voice_identification
  const update = useUpdateSettings()
  const [enabled, setEnabled] = useState(voice.enabled)
  const [threshold, setThreshold] = useState(String(Math.round(voice.suggestion_threshold * 100)))
  const [saved, setSaved] = useState(false)
  const thresholdId = useId()
  const percent = Number(threshold)
  const valid = Number.isInteger(percent) && percent >= 0 && percent <= 100

  function submit(event: FormEvent) {
    event.preventDefault()
    setSaved(false)
    update.mutate(
      { voice_identification: { enabled, suggestion_threshold: percent / 100 } },
      { onSuccess: () => setSaved(true) },
    )
  }

  return (
    <form className={`card ${styles.form}`} onSubmit={submit} aria-label="Configuração da identificação por voz">
      <fieldset className={styles.fieldset}>
        <legend>Plataforma</legend>
        <label className={styles.check}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span>
            <span>Ligar a identificação por voz</span>
            <span className="field-hint">
              Desligada, nada é comparado nem guardado como impressão, e as sugestões pendentes somem. Desligar apaga as
              impressões de voz por gravação de todas as contas; as vozes já confirmadas ficam até o usuário esquecê-las
              na página da pessoa.
            </span>
          </span>
        </label>
        <div className="field">
          <label htmlFor={thresholdId}>Semelhança mínima para sugerir (%)</label>
          <input
            id={thresholdId}
            className="input"
            type="number"
            min={0}
            max={100}
            step={1}
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
          />
          <span className="field-hint">
            O padrão veio da calibração com fala real em português; mais alto, menos sugestões erradas e mais
            pessoas não reconhecidas.
          </span>
        </div>
      </fieldset>
      {update.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(update.error)}
        </p>
      )}
      <div className={styles.actions}>
        <button type="submit" className="btn btn-primary" disabled={update.isPending || !valid}>
          {update.isPending ? 'Salvando…' : 'Salvar'}
        </button>
        <span role="status" className={styles.meta}>
          {saved ? 'Configuração de voz salva.' : ''}
        </span>
      </div>
    </form>
  )
}
