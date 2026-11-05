import { useId, useState, type FormEvent } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import type { Schemas } from '../../api/client'
import { errorMessage } from '../../api/problem'
import { AdminPageHead } from './AdminPageHead'
import { ExternalDataNotice } from './ExternalDataNotice'
import styles from './Admin.module.css'
import { COMPUTE_TYPES, ENGINES, lastChangeText, MODELS, optionalInt } from './labels'
import { useAdminSettings, useUpdateSettings } from './queries'
import { AUTO_LANGUAGE, whisperLanguages } from '../../lib/languages'

type Settings = Schemas['AdminSettings']
type Asr = Schemas['AsrSettings']

const FORM_ID = 'admin-transcricao'

/** Transcription engine, model and language; diarization and identification live in Locutores. */
export function TranscriptionPage() {
  const { t } = useTranslation('admin')
  const settings = useAdminSettings()
  if (settings.data) return <TranscriptionForm settings={settings.data} />
  return (
    <>
      <AdminPageHead title={t('transcription.title')} />
      {settings.isPending && <p role="status">{t('settings.loading')}</p>}
      {settings.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(settings.error)}
        </p>
      )}
    </>
  )
}

function TranscriptionForm({ settings }: { settings: Settings }) {
  const { t } = useTranslation('admin')
  const update = useUpdateSettings()
  const [engine, setEngine] = useState(settings.asr.engine)
  const [model, setModel] = useState(settings.asr.model)
  const [language, setLanguage] = useState(settings.asr.default_language ?? 'pt')
  const [computeType, setComputeType] = useState(settings.asr.compute_type)
  const [batchSize, setBatchSize] = useState(settings.asr.batch_size?.toString() ?? '')
  const [fallbackModel, setFallbackModel] = useState(settings.asr.fallback_model ?? '')
  const [endpoint, setEndpoint] = useState(settings.asr.endpoint_url ?? '')
  // What was saved last: the notice holds until the form changes again.
  const [sent, setSent] = useState<string | null>(null)
  // Rebuilt on each render, so the names follow the active locale.
  const languages = whisperLanguages()
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
    endpoint_url: endpoint.trim() || null,
  }
  // With no saved language, the server uses Portuguese: the form starts from it.
  const current = { ...settings.asr, default_language: settings.asr.default_language ?? 'pt' }
  const changed = (Object.keys(asr) as (keyof Asr)[]).some((key) => asr[key] !== current[key])
  const valid = !remote || Boolean(asr.endpoint_url)
  const canSave = changed && valid && !update.isPending

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!canSave) return
    const json = JSON.stringify(asr)
    setSent(null)
    update.mutate({ asr }, { onSuccess: () => setSent(json) })
  }

  return (
    <>
      <AdminPageHead
        title={t('transcription.title')}
        actions={
          // Outside the form, in the header: `form=` ties it to the form; Enter in the fields also saves.
          <button type="submit" form={FORM_ID} className="btn btn-primary" disabled={!canSave}>
            {update.isPending ? t('settings.saving') : t('settings.save')}
          </button>
        }
      />
      <ExternalDataNotice purposes={['transcription']} revision={settings.updated_at} />
      <form id={FORM_ID} className={styles.narrowForm} onSubmit={submit} aria-label={t('transcription.form')}>
        <div className="field">
          <span id={ids.engine} className={styles.label}>
            {t('transcription.engine')}
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
            <label htmlFor={ids.endpoint}>{t('transcription.endpoint')}</label>
            <input
              id={ids.endpoint}
              className="input"
              type="url"
              required
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder="http://speaches:8000/v1" // i18n-ignore: a sample address
            />
          </div>
        )}
        <div className="field">
          <label htmlFor={ids.model}>{t('transcription.model')}</label>
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
          <label htmlFor={ids.language}>{t('transcription.language')}</label>
          <select id={ids.language} className="input" value={language} onChange={(e) => setLanguage(e.target.value)}>
            {language !== AUTO_LANGUAGE && !languages.some((option) => option.value === language) && (
              <option value={language}>{language}</option>
            )}
            <option value={AUTO_LANGUAGE}>{t('transcription.auto')}</option>
            <optgroup label={t('transcription.languages', { count: languages.length })}>
              {languages.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </optgroup>
          </select>
          <span className="field-hint">{t('transcription.languageHint')}</span>
        </div>
        <details className={styles.advanced}>
          <summary>{t('transcription.advanced')}</summary>
          <div className={styles.stack}>
            <div className="field">
              <label htmlFor={ids.compute}>{t('transcription.compute')}</label>
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
              <label htmlFor={ids.batch}>{t('transcription.batch')}</label>
              <input
                id={ids.batch}
                className="input"
                type="number"
                min={1}
                value={batchSize}
                onChange={(e) => setBatchSize(e.target.value)}
                placeholder={t('transcription.batchAuto')}
              />
              <span className="field-hint">{t('transcription.batchHint')}</span>
            </div>
            <div className="field">
              <label htmlFor={ids.fallback}>{t('transcription.fallback')}</label>
              <input
                id={ids.fallback}
                className="input"
                list={ids.models}
                value={fallbackModel}
                onChange={(e) => setFallbackModel(e.target.value)}
                placeholder="medium" // i18n-ignore: a model name
              />
              <datalist id={ids.models}>
                {MODELS.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
              <span className="field-hint">{t('transcription.fallbackHint')}</span>
            </div>
          </div>
        </details>
        <p className="text-muted">
          <Trans t={t} i18nKey="transcription.speakers" components={{ speakers: <Link to="/admin/locutores" /> }} />
        </p>
        {update.isError && (
          <p className="alert alert-error" role="alert">
            {errorMessage(update.error)}
          </p>
        )}
        <p role="status" className="text-muted">
          {sent === JSON.stringify(asr) ? t('settings.saved') : ''}
        </p>
        <p className={styles.meta}>{lastChangeText(settings)}</p>
      </form>
    </>
  )
}
