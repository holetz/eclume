import { useId, useMemo, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import type { Schemas } from '../../api/client'
import { errorMessage } from '../../api/problem'
import { PageHead } from '../../app/PageHead'
import styles from './Admin.module.css'
import { COMPUTE_TYPES, ENGINES, lastChangeText, MODELS, optionalInt } from './labels'
import { useAdminSettings, useUpdateSettings } from './queries'
import { ADMIN_KICKER } from './sections'
import { whisperLanguages } from './whisperLanguages'

type Settings = Schemas['AdminSettings']
type Asr = Schemas['AsrSettings']

const FORM_ID = 'admin-transcricao'

/** Motor, modelo e idioma da transcrição; a separação e a identificação ficam em Locutores. */
export function TranscriptionPage() {
  const settings = useAdminSettings()
  if (settings.data) return <TranscriptionForm settings={settings.data} />
  return (
    <>
      <PageHead kicker={ADMIN_KICKER} title="Transcrição" />
      {settings.isPending && <p role="status">Carregando a configuração…</p>}
      {settings.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(settings.error)}
        </p>
      )}
    </>
  )
}

function TranscriptionForm({ settings }: { settings: Settings }) {
  const update = useUpdateSettings()
  const [engine, setEngine] = useState(settings.asr.engine)
  const [model, setModel] = useState(settings.asr.model)
  const [language, setLanguage] = useState(settings.asr.default_language ?? 'pt')
  const [computeType, setComputeType] = useState(settings.asr.compute_type)
  const [batchSize, setBatchSize] = useState(settings.asr.batch_size?.toString() ?? '')
  const [fallbackModel, setFallbackModel] = useState(settings.asr.fallback_model ?? '')
  const [endpoint, setEndpoint] = useState(settings.asr.endpoint_url ?? '')
  const [saved, setSaved] = useState(false)
  const languages = useMemo(() => whisperLanguages(), [])
  const ids = {
    engine: useId(),
    endpoint: useId(),
    model: useId(),
    language: useId(),
    compute: useId(),
    batch: useId(),
    fallback: useId(),
    models: useId(),
  }
  const remote = engine === 'openai-compatible'

  const asr: Asr = {
    engine,
    model,
    compute_type: computeType,
    batch_size: optionalInt(batchSize),
    default_language: language,
    fallback_model: fallbackModel.trim() || null,
    endpoint_url: remote ? endpoint.trim() || null : settings.asr.endpoint_url,
  }
  // Sem idioma salvo, o server usa o português: o form já parte dele.
  const current = { ...settings.asr, default_language: settings.asr.default_language ?? 'pt' }
  const changed = (Object.keys(asr) as (keyof Asr)[]).some((key) => asr[key] !== current[key])
  const valid = !remote || Boolean(asr.endpoint_url)
  const canSave = changed && valid && !update.isPending

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!canSave) return
    setSaved(false)
    update.mutate({ asr }, { onSuccess: () => setSaved(true) })
  }

  return (
    <>
      <PageHead
        kicker={ADMIN_KICKER}
        title="Transcrição"
        actions={
          // Fora do form, no cabeçalho: `form=` o liga ao form, e Enter nos campos também salva.
          <button type="submit" form={FORM_ID} className="btn btn-primary" disabled={!canSave}>
            {update.isPending ? 'Salvando…' : 'Salvar'}
          </button>
        }
      />
      <form
        id={FORM_ID}
        className={styles.narrowForm}
        onSubmit={submit}
        aria-label="Configuração de transcrição"
      >
        <div className="field">
          <span id={ids.engine} className={styles.label}>
            Motor
          </span>
          <div className="seg" role="radiogroup" aria-labelledby={ids.engine}>
            {ENGINES.map((option) => (
              <label key={option.value} className="seg-opt">
                <input
                  type="radio"
                  name={ids.engine}
                  value={option.value}
                  checked={engine === option.value}
                  onChange={() => setEngine(option.value as Asr['engine'])}
                />
                {option.label}
              </label>
            ))}
          </div>
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
        <div className="field">
          <label htmlFor={ids.model}>Modelo</label>
          <select id={ids.model} className="input" value={model} onChange={(e) => setModel(e.target.value)}>
            {!MODELS.includes(model as (typeof MODELS)[number]) && <option value={model}>{model}</option>}
            {MODELS.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={ids.language}>Idioma</label>
          <select id={ids.language} className="input" value={language} onChange={(e) => setLanguage(e.target.value)}>
            {!languages.some((option) => option.value === language) && <option value={language}>{language}</option>}
            <optgroup label={`Idiomas (${languages.length})`}>
              {languages.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </optgroup>
          </select>
          <span className="field-hint">Os modelos Whisper aceitam um idioma por gravação.</span>
        </div>
        <details className={styles.advanced}>
          <summary>Avançado</summary>
          <div className={styles.stack}>
            <div className="field">
              <label htmlFor={ids.compute}>Tipo de computação</label>
              <select
                id={ids.compute}
                className="input"
                value={computeType}
                onChange={(e) => setComputeType(e.target.value)}
              >
                {!COMPUTE_TYPES.some((option) => option.value === computeType) && (
                  <option value={computeType}>{computeType}</option>
                )}
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
              <span className="field-hint">Vazio: pela VRAM livre.</span>
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
              <datalist id={ids.models}>
                {MODELS.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
              <span className="field-hint">Usado se faltar VRAM mesmo com lote 1.</span>
            </div>
          </div>
        </details>
        <p className="text-muted">
          A separação e a identificação de locutores ficam em <Link to="/admin/locutores">Locutores</Link>.
        </p>
        {update.isError && (
          <p className="alert alert-error" role="alert">
            {errorMessage(update.error)}
          </p>
        )}
        <p role="status" className="text-muted">
          {saved && !changed ? 'Configuração salva.' : ''}
        </p>
        <p className={styles.meta}>{lastChangeText(settings)}</p>
      </form>
    </>
  )
}
