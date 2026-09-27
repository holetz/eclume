import { useId, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import type { Schemas } from '../../api/client'
import { errorMessage } from '../../api/problem'
import { usePageTitle } from '../../app/usePageTitle'
import { formatDateTime } from '../library/format'
import styles from './Admin.module.css'
import { COMPUTE_TYPES, ENGINES, LANGUAGES, MODELS, optionalInt } from './labels'
import { useAdminSettings, useUpdateSettings } from './queries'
import { sectionTitle } from './sections'

type Settings = Schemas['AdminSettings']

/** Configuração de transcrição (ASR, diarização, idioma) e o resumo automático. */
export function SettingsPage() {
  usePageTitle(sectionTitle('transcricao'))
  const settings = useAdminSettings()
  return (
    <section className={styles.page} aria-labelledby="transcricao-titulo">
      <div className={styles.intro}>
        <h2 id="transcricao-titulo">Transcrição</h2>
        <p className="text-muted">
          Motor e modelo de ASR, diarização e idioma. O próximo job de transcrição já sai com o que for salvo aqui; os já
          transcritos não mudam (use “Transcrever de novo” na gravação).
        </p>
      </div>
      {settings.isPending && <p role="status">Carregando a configuração…</p>}
      {settings.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(settings.error)}
        </p>
      )}
      {settings.data && <SettingsForm settings={settings.data} />}
    </section>
  )
}

function SettingsForm({ settings }: { settings: Settings }) {
  const update = useUpdateSettings()
  const [engine, setEngine] = useState(settings.asr.engine)
  const [model, setModel] = useState(settings.asr.model)
  const [computeType, setComputeType] = useState(settings.asr.compute_type)
  const [batchSize, setBatchSize] = useState(settings.asr.batch_size?.toString() ?? '')
  const [fallbackModel, setFallbackModel] = useState(settings.asr.fallback_model ?? '')
  const [endpoint, setEndpoint] = useState(settings.asr.endpoint_url ?? '')
  const [language, setLanguage] = useState(settings.asr.default_language ?? 'pt')
  const [diarize, setDiarize] = useState(settings.diarization.enabled)
  const [minSpeakers, setMinSpeakers] = useState(settings.diarization.min_speakers?.toString() ?? '')
  const [maxSpeakers, setMaxSpeakers] = useState(settings.diarization.max_speakers?.toString() ?? '')
  const [saved, setSaved] = useState(false)
  const ids = {
    engine: useId(),
    model: useId(),
    models: useId(),
    compute: useId(),
    batch: useId(),
    fallback: useId(),
    endpoint: useId(),
    language: useId(),
    min: useId(),
    max: useId(),
  }
  const remote = engine === 'openai-compatible'
  const knownLanguage = LANGUAGES.some((option) => option.value === language)

  function submit(event: FormEvent) {
    event.preventDefault()
    setSaved(false)
    update.mutate(
      {
        asr: {
          engine,
          model: model.trim(),
          compute_type: computeType,
          batch_size: optionalInt(batchSize),
          fallback_model: fallbackModel.trim() || null,
          endpoint_url: endpoint.trim() || null,
          default_language: language,
        },
        diarization: { enabled: diarize, min_speakers: optionalInt(minSpeakers), max_speakers: optionalInt(maxSpeakers) },
      },
      { onSuccess: () => setSaved(true) },
    )
  }

  return (
    <form className={`card ${styles.form}`} onSubmit={submit} aria-label="Configuração de transcrição">
      <fieldset className={styles.fieldset}>
        <legend>Reconhecimento de fala (ASR)</legend>
        <div className="field">
          <label htmlFor={ids.engine}>Motor</label>
          <select id={ids.engine} className="input" value={engine} onChange={(e) => setEngine(e.target.value as typeof engine)}>
            {ENGINES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <span className="field-hint">{ENGINES.find((option) => option.value === engine)?.hint}</span>
        </div>
        {remote && (
          <div className="field">
            <label htmlFor={ids.endpoint}>Endereço do servidor remoto</label>
            <input
              id={ids.endpoint}
              className="input"
              type="url"
              required
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder="http://speaches:8000/v1"
            />
          </div>
        )}
        <div className={styles.row}>
          <div className="field">
            <label htmlFor={ids.model}>Modelo</label>
            <input
              id={ids.model}
              className="input"
              list={ids.models}
              required
              value={model}
              onChange={(e) => setModel(e.target.value)}
            />
            <datalist id={ids.models}>
              {MODELS.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </div>
          <div className="field">
            <label htmlFor={ids.compute}>Tipo de computação</label>
            <select id={ids.compute} className="input" value={computeType} onChange={(e) => setComputeType(e.target.value)}>
              {!COMPUTE_TYPES.some((option) => option.value === computeType) && <option value={computeType}>{computeType}</option>}
              {COMPUTE_TYPES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={ids.batch}>Lote do ASR</label>
            <input
              id={ids.batch}
              className="input"
              type="number"
              min={1}
              value={batchSize}
              onChange={(e) => setBatchSize(e.target.value)}
              placeholder="Automático"
            />
            <span className="field-hint">Vazio: pela VRAM livre (4 ou 2).</span>
          </div>
          <div className="field">
            <label htmlFor={ids.fallback}>Modelo de recuo</label>
            <input
              id={ids.fallback}
              className="input"
              list={ids.models}
              value={fallbackModel}
              onChange={(e) => setFallbackModel(e.target.value)}
              placeholder="medium"
            />
            <span className="field-hint">Usado se faltar VRAM mesmo com lote 1.</span>
          </div>
        </div>
        <div className="field">
          <label htmlFor={ids.language}>Idioma padrão</label>
          <select id={ids.language} className="input" value={language} onChange={(e) => setLanguage(e.target.value)}>
            {!knownLanguage && <option value={language}>{language}</option>}
            {LANGUAGES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <span className="field-hint">Vale quando a gravação não informa o idioma.</span>
        </div>
      </fieldset>

      <fieldset className={styles.fieldset}>
        <legend>Diarização (quem falou)</legend>
        <label className={styles.check}>
          <input type="checkbox" checked={diarize} onChange={(e) => setDiarize(e.target.checked)} />
          <span>
            <span>Separar os locutores</span>
            <span className="field-hint">
              Exige o token do Hugging Face em <Link to="/admin/segredos">Segredos</Link>; sem ele, a transcrição sai
              com um locutor só.
            </span>
          </span>
        </label>
        <div className={styles.row}>
          <div className="field">
            <label htmlFor={ids.min}>Mínimo de locutores</label>
            <input
              id={ids.min}
              className="input"
              type="number"
              min={1}
              disabled={!diarize}
              value={minSpeakers}
              onChange={(e) => setMinSpeakers(e.target.value)}
              placeholder="Automático"
            />
          </div>
          <div className="field">
            <label htmlFor={ids.max}>Máximo de locutores</label>
            <input
              id={ids.max}
              className="input"
              type="number"
              min={1}
              disabled={!diarize}
              value={maxSpeakers}
              onChange={(e) => setMaxSpeakers(e.target.value)}
              placeholder="Automático"
            />
          </div>
        </div>
      </fieldset>

      {update.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(update.error)}
        </p>
      )}
      <div className={styles.actions}>
        <button type="submit" className="btn btn-primary" disabled={update.isPending || !model.trim() || (remote && !endpoint.trim())}>
          {update.isPending ? 'Salvando…' : 'Salvar configuração'}
        </button>
        <span role="status" className={styles.meta}>
          {saved ? 'Configuração salva.' : ''}
        </span>
      </div>
      <p className={styles.meta}>
        {settings.updated_by
          ? `Última alteração por ${settings.updated_by.name} em ${formatDateTime(settings.updated_at)}.`
          : 'Configuração padrão, ainda não alterada.'}
      </p>
    </form>
  )
}
