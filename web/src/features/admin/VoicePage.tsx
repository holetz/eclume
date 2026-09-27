import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useId, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { api, type Schemas } from '../../api/client'
import { errorMessage, unwrap } from '../../api/problem'
import { usePageTitle } from '../../app/usePageTitle'
import { formatDateTime } from '../library/format'
import { PEOPLE_KEY } from '../people/queries'
import styles from './Admin.module.css'
import { useAdminSettings, useUpdateSettings } from './queries'
import { sectionTitle } from './sections'
import { AUDIT_EVENTS, VOICE_AUDIT_KEY } from './voice'

type Settings = Schemas['AdminSettings']

/** Identificação por voz: opt-in da organização (LGPD), limiar, termo, auditoria e purga. */
export function VoicePage() {
  usePageTitle(sectionTitle('voz'))
  const settings = useAdminSettings()
  return (
    <section className={styles.page} aria-labelledby="voz-titulo">
      <div className={styles.intro}>
        <h2 id="voz-titulo">Identificação por voz</h2>
        <p className="text-muted">
          O eclume pode sugerir quem é cada locutor comparando a voz com a de pessoas que já foram confirmadas. Voz é
          dado biométrico (LGPD): só entra quem tem o consentimento registrado na página da pessoa, e nenhuma sugestão
          vira identificação sem alguém aceitar.
        </p>
      </div>
      {settings.isPending && <p role="status">Carregando a configuração…</p>}
      {settings.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(settings.error)}
        </p>
      )}
      {settings.data && <VoiceForm settings={settings.data} />}
      <Audit />
      <Purge />
    </section>
  )
}

function VoiceForm({ settings }: { settings: Settings }) {
  const voice = settings.voice_identification
  const update = useUpdateSettings()
  const [enabled, setEnabled] = useState(voice.enabled)
  const [threshold, setThreshold] = useState(String(Math.round(voice.suggestion_threshold * 100)))
  const [term, setTerm] = useState(voice.consent_term_text ?? '')
  const [saved, setSaved] = useState(false)
  const ids = { threshold: useId(), term: useId() }
  const percent = Number(threshold)
  const valid = Number.isInteger(percent) && percent >= 0 && percent <= 100 && term.trim().length > 0

  function submit(event: FormEvent) {
    event.preventDefault()
    setSaved(false)
    const body: Schemas['AdminSettingsPatch']['voice_identification'] = {
      enabled,
      suggestion_threshold: percent / 100,
    }
    if (term.trim() !== voice.consent_term_text) body.consent_term_text = term.trim()
    update.mutate({ voice_identification: body }, { onSuccess: () => setSaved(true) })
  }

  return (
    <form className={`card ${styles.form}`} onSubmit={submit} aria-label="Configuração da identificação por voz">
      <fieldset className={styles.fieldset}>
        <legend>Opt-in da organização</legend>
        <label className={styles.check}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span>
            <span>Ligar a identificação por voz</span>
            <span className="field-hint">
              Desligada, nada é comparado nem guardado como impressão, e as sugestões pendentes somem da tela. As
              impressões já guardadas ficam até alguém excluí-las (abaixo, ou na página de cada pessoa).
            </span>
          </span>
        </label>
        <div className="field">
          <label htmlFor={ids.threshold}>Semelhança mínima para sugerir (%)</label>
          <input
            id={ids.threshold}
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
      <fieldset className={styles.fieldset}>
        <legend>Termo de consentimento (versão {voice.consent_term_version})</legend>
        <div className="field">
          <label htmlFor={ids.term}>Texto que a pessoa aceita</label>
          <textarea id={ids.term} className="input" rows={6} value={term} onChange={(e) => setTerm(e.target.value)} />
          <span className="field-hint">
            Mudar o texto cria uma versão nova; cada consentimento guarda o texto que foi aceito.
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

function Audit() {
  const audit = useQuery({
    queryKey: VOICE_AUDIT_KEY,
    queryFn: () => unwrap(api.GET('/api/v1/admin/voice-audit', { params: { query: { limit: 50 } } })),
  })
  return (
    <section className={styles.section} aria-labelledby="voz-auditoria">
      <h3 id="voz-auditoria">Trilha de auditoria</h3>
      {audit.isPending && <p role="status">Carregando a trilha…</p>}
      {audit.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(audit.error)}
        </p>
      )}
      {audit.isSuccess && audit.data.items.length === 0 && <p className="text-muted">Nenhum evento ainda.</p>}
      {audit.isSuccess && audit.data.items.length > 0 && (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className="visually-hidden">Eventos de voz mais recentes</caption>
            <thead>
              <tr>
                <th scope="col">Quando</th>
                <th scope="col">Evento</th>
                <th scope="col">Pessoa</th>
                <th scope="col">Quem</th>
                <th scope="col">Semelhança</th>
              </tr>
            </thead>
            <tbody>
              {audit.data.items.map((event) => (
                <tr key={event.id}>
                  <td>{formatDateTime(event.created_at)}</td>
                  <td>{AUDIT_EVENTS[event.event] ?? event.event}</td>
                  <td>{event.person ? <Link to={`/pessoas/${event.person.id}`}>{event.person.name}</Link> : '—'}</td>
                  <td>{event.actor?.name ?? 'Sistema'}</td>
                  <td className="tabular">{event.score == null ? '—' : `${Math.round(event.score * 100)}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function Purge() {
  const queryClient = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const purge = useMutation({
    mutationFn: () => unwrap(api.DELETE('/api/v1/admin/voiceprints')),
    onSuccess: () => {
      setConfirming(false)
      void queryClient.invalidateQueries({ queryKey: PEOPLE_KEY })
      void queryClient.invalidateQueries({ queryKey: VOICE_AUDIT_KEY })
    },
  })
  return (
    <section className={styles.section} aria-labelledby="voz-purga">
      <h3 id="voz-purga">Apagar todas as impressões</h3>
      <p className="text-muted">
        Apaga as impressões de voz de todas as pessoas e as sugestões pendentes. Consentimentos e auditoria ficam.
      </p>
      {confirming ? (
        <div className={styles.actions}>
          <button type="button" className="btn btn-danger" onClick={() => purge.mutate()} disabled={purge.isPending}>
            Confirmar: apagar todas
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => setConfirming(false)}>
            Manter
          </button>
        </div>
      ) : (
        <button type="button" className="btn btn-danger" onClick={() => setConfirming(true)}>
          Apagar todas as impressões
        </button>
      )}
      {purge.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(purge.error)}
        </p>
      )}
      <p role="status" className={styles.meta}>
        {purge.data
          ? `${purge.data.deleted_samples} amostras e ${purge.data.deleted_suggestions} sugestões apagadas.`
          : ''}
      </p>
    </section>
  )
}
