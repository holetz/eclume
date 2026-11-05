import { t, useT } from '../i18n'
import { useEffect, useRef, useState } from 'react'
import { clock, duration, longDate, size } from '../app/formats'
import { PauseIcon, PlayIcon } from '../app/Icons'
import { Back } from '../app/Back'
import { errorMessage, useBridge } from '../bridge/bridge'
import type { LocalDetail, Step } from '../bridge/types'
import { RecordingBadge } from './PhoneList'
import { stepName, stepStateLabel, reasonText, waitingPhrase } from '../i18n/vocabulary'

const STEPS = ['received', 'preprocessing', 'transcription', 'speakers', 'agenda_type', 'fields', 'summary'] as const

/** The step in words, readable without the color: the name when done, the progress when active and "name · state" otherwise. */
function stepLabel(step: (typeof STEPS)[number], state: Step | undefined): string {
  if (!state || state.state === 'done') return stepName(step)
  if (state.state === 'active') return t(`detail.active.${step}`)
  return `${stepName(step)} · ${stepStateLabel(state.state)}`
}

/** Why the step was skipped, failed or waits for you (the speakers without a person); `null` otherwise. */
function stepReason(state: Step | undefined): string | null {
  if (state?.state === 'failed') return state.error?.message ?? null
  if (state?.state === 'skipped' || state?.state === 'waiting') return state.reason ? reasonText(state.reason) : null
  return null
}

/** The seven steps in the server's order, each with its state in words, and the reason of the skipped or failed ones. */
function ServerSteps({ steps }: { steps: Step[] | null }) {
  const t = useT()
  const rows = STEPS.map((step) => {
    const state = steps?.find((e) => e.step === step)
    return { step, state, label: stepLabel(step, state), reason: stepReason(state) }
  })
  const reasons = rows.filter((row) => row.reason)
  return (
    <>
      <ol className="pipeline" aria-label={t('detail.steps')}>
        {rows.map(({ step, state, label }) => (
          <li key={step} data-state={state?.state === 'pending' ? undefined : state?.state}>
            {label}
          </li>
        ))}
      </ol>
      {reasons.length > 0 && (
        <ul className="step-reasons" aria-label={t('detail.reasons')}>
          {reasons.map(({ step, label, reason }) => (
            <li key={step}>
              {label}: {reason}
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

/** Kbps from the size and the duration: "Opus 24 kbps". */
function fileBitrate(bytes: number | null, ms: number | null): string | null {
  if (!bytes || !ms) return null
  return `Opus ${Math.round((bytes * 8) / (ms / 1000) / 1000)} kbps`
}

/** A recording's detail: the local player, the markers, the steps on the server and the queue wait. */
export function Detail({ id, go }: { id: string; go: (route: string) => void }) {
  const t = useT()
  const bridge = useBridge()
  const [detail, setDetail] = useState<LocalDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [position, setPosition] = useState(0)
  const audio = useRef<HTMLAudioElement>(null)

  useEffect(() => {
    let active = true
    bridge
      .recording(id)
      .then((read) => active && setDetail(read))
      .catch((e) => active && setError(errorMessage(e)))
    return () => {
      active = false
    }
  }, [bridge, id])

  async function remove() {
    try {
      await bridge.deleteLocal(id)
      setDetail(await bridge.recording(id))
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  async function openOnWeb() {
    try {
      await bridge.openOnWeb(id)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  function toggle() {
    const element = audio.current
    if (!element) return
    if (element.paused) element.play().catch(() => {})
    else element.pause()
  }

  function seek(ms: number) {
    if (audio.current) audio.current.currentTime = ms / 1000
  }

  const recording = detail?.gravacao
  const total = recording?.duracao_ms ?? 0
  const facts = recording
    ? [duration(recording.duracao_ms), size(recording.bytes), fileBitrate(recording.bytes, recording.duracao_ms), recording.tipo_de_agenda]
        .filter(Boolean)
        .join(' · ')
    : ''
  return (
    <div className="m-body m-scroll">
      <Back label={t('detail.onPhone')} onBack={() => go('/')} />
      {error && (
        <p className="error-text m-section" role="alert">
          {error}
        </p>
      )}
      {detail && recording && (
        <>
          <div className="m-section gap-tight top-1">
            <span className="kicker">{longDate(recording.iniciada_em)}</span>
            <h1 className="m-title">{recording.titulo ?? recording.titulo_do_servidor ?? t('detail.untitled')}</h1>
            <span className="align-start">
              <RecordingBadge badge={recording.selo} />
            </span>
          </div>
          {detail.caminho && (
            <div className="padding-x">
              <audio
                ref={audio}
                src={bridge.fileUrl(detail.caminho)}
                preload="metadata"
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onTimeUpdate={(e) => setPosition(e.currentTarget.currentTime * 1000)}
              />
              <div className="player">
                <button
                  type="button"
                  className="btn btn-primary btn-icon button-44"
                  aria-label={playing ? t('detail.pause') : t('detail.play')}
                  onClick={toggle}
                >
                  {playing ? <PauseIcon /> : <PlayIcon />}
                </button>
                <span>{clock(position)}</span>
                <progress className="progress" value={total ? (position / total) * 100 : 0} max={100} />
                <span className="text-muted">{clock(total)}</span>
              </div>
            </div>
          )}
          <div className="m-section">
            <div className="row-between">
              <span className="kicker">{t('detail.markers')}</span>
              <span className="text-muted text-12">
                {detail.marcadores.length}
              </span>
            </div>
            <ul className="markers">
              {detail.marcadores.map((m) => (
                <li key={m.client_id} data-empty={m.note ? undefined : ''}>
                  <button type="button" className="timecode text-button" onClick={() => seek(m.at_ms)}>
                    {clock(m.at_ms)}
                  </button>
                  <span>{m.note ?? t('common.marker')}</span>
                </li>
              ))}
            </ul>
          </div>
          {recording.remote_id && (
            <div className="m-section gap-2">
              <span className="kicker">{t('detail.onServer')}</span>
              <ServerSteps steps={detail.etapas} />
              {detail.espera && (
                <p className="text-muted text-13" role="status">
                  {waitingPhrase(detail.espera)}
                </p>
              )}
              {detail.endereco_na_web && (
                <button type="button" className="btn btn-secondary button-start" onClick={openOnWeb}>
                  {t('detail.openWeb')}
                </button>
              )}
            </div>
          )}
          <div className="m-section m-fill gap-2">
            <span className="text-muted text-13">
              {facts}
            </span>
            {recording.selo === 'sincronizada' && !recording.apagada && (
              <>
                <button
                  type="button"
                  className="btn btn-secondary btn-danger button-start"
                  onClick={remove}
                >
                  {t('detail.delete')}
                </button>
                <span className="text-muted text-12">{t('detail.serverCopy')}</span>
              </>
            )}
            {recording.apagada && (
              <span className="text-muted text-12">{t('detail.deleted')}</span>
            )}
          </div>
        </>
      )}
    </div>
  )
}
