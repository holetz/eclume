import { useT } from '../i18n'
import { useEffect, useState, type FormEvent } from 'react'
import { duration, markers, suggestedTitle } from '../app/formats'
import { errorMessage, useBridge } from '../bridge/bridge'
import type { AgendaType, LanguageOption, Sheet } from '../bridge/types'

/**
 * The saved-recording sheet, after Stop: title, agenda type and language, all optional (the
 * language starts from the named account default). While it is open, the sync waits (up to 10 min);
 * Save or Skip releases it.
 */
export function RecordingSaved({ sheet }: { sheet: Sheet }) {
  const t = useT()
  const bridge = useBridge()
  const [title, setTitle] = useState('')
  const [type, setType] = useState<string | null>(null)
  const [types, setTypes] = useState<AgendaType[]>([])
  const [language, setLanguage] = useState('')
  const [languages, setLanguages] = useState<LanguageOption[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    bridge
      .agendaTypes()
      .then((list) => active && setTypes(list))
      .catch(() => {})
    bridge
      .languages()
      .then((list) => active && setLanguages(list))
      .catch(() => {})
    return () => {
      active = false
    }
  }, [bridge])

  async function finish(save: boolean) {
    setError(null)
    try {
      await bridge.save(
        sheet.id,
        save ? title.trim() || null : null,
        save ? type : null,
        save ? language || null : null,
      )
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    finish(true)
  }

  return (
    <div className="sheet-backdrop">
      <form className="sheet" onSubmit={submit} aria-labelledby="sheet-title">
        <span className="sheet-grip" />
        <div className="stack-tight gap-1">
          <h2 id="sheet-title" className="m-title text-24">
            {t('saved.title')}
          </h2>
          <span className="text-muted text-14">
            {duration(sheet.duracao_ms)} · {markers(sheet.marcadores)} · {t('saved.onPhone')}
          </span>
        </div>
        <div className="field">
          <label htmlFor="title">{t('saved.optionalTitle')}</label>
          <input
            id="title"
            className="input"
            placeholder={suggestedTitle(sheet.iniciada_em)}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        {types.length > 0 && (
          <div className="field">
            <span className="field-label">{t('saved.optionalType')}</span>
            <div className="m-chips">
              {types.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className="m-chip"
                  aria-pressed={type === t.id}
                  onClick={() => setType(type === t.id ? null : t.id)}
                >
                  {t.nome}
                </button>
              ))}
            </div>
          </div>
        )}
        {languages.length > 0 && (
          <div className="field">
            <label htmlFor="language">{t('saved.language')}</label>
            <select
              id="language"
              className="input"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
            >
              {languages.map((option) => (
                <option key={option.valor} value={option.valor}>
                  {option.rotulo}
                </option>
              ))}
            </select>
          </div>
        )}
        <span className="text-muted text-13">
          {t('saved.fieldsHelp')}
        </span>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <div className="two-columns">
          <button type="submit" className="btn btn-primary button-start">
            {t('common.save')}
          </button>
          <button
            type="button"
            className="btn btn-secondary button-start"
            onClick={() => finish(false)}
          >
            {t('saved.skip')}
          </button>
        </div>
      </form>
    </div>
  )
}
