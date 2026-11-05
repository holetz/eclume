import { useT } from '../i18n'
import { useState } from 'react'
import { clock } from '../app/formats'
import { MarkerIcon, PauseIcon, PlayIcon, StopIcon } from '../app/Icons'
import { errorMessage, useBridge } from '../bridge/bridge'
import type { AppState, Marker } from '../bridge/types'
import { MarkerNote } from './MarkerNote'
import { Meter } from './Meter'
import { RecordingSaved } from './RecordingSaved'

/**
 * Recording and Paused: the clock is the audio time, the meter is the level, and the markers stay in
 * the list. Marker marks right away; the note comes after, optional. After Stop, the saved-recording
 * sheet asks for the title and the agenda type.
 */
export function Recording({ state }: { state: AppState }) {
  const t = useT()
  const bridge = useBridge()
  const [annotating, setAnnotating] = useState<Marker | null>(null)
  const [error, setError] = useState<string | null>(null)
  const session = state.sessao
  const paused = session?.pausada ?? false

  async function run(action: () => Promise<unknown>) {
    setError(null)
    try {
      await action()
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  async function mark() {
    await run(async () => setAnnotating(await bridge.mark(null)))
  }

  async function stop() {
    setAnnotating(null)
    await run(() => bridge.stop())
  }

  const markers = session?.marcadores ?? []
  const audioMs = session?.audio_ms ?? state.folha?.duracao_ms ?? 0
  const battery = state.avisos.bateria
  return (
    <div className="m-body no-bottom">
      <div className="m-top">
        <span className="status-line" data-status={paused ? 'paused' : 'recording'}>
          {paused ? t('recording.paused') : t('recording.active')}
        </span>
        {state.espaco_livre && (
          <span className="text-muted text-13">
            {t('recording.freeSpace', { remaining: state.espaco_livre })}
          </span>
        )}
      </div>
      {state.conexao.fase === 'sem_credencial' && (
        <div className="alert alert-warning margin-x" role="status">
          <span className="alert-title">{t('recording.signIn')}</span>
          <span>{t('recording.signInHelp')}</span>
        </div>
      )}
      {session?.silenciada ? (
        <div className="alert alert-warning margin-x" role="status">
          <span className="alert-title">{t('recording.muted')}</span>
          <span>{t('recording.mutedHelp')}</span>
        </div>
      ) : (
        session?.microfone === 'reconectando' && (
          <div className="alert alert-warning margin-x" role="status">
            <span className="alert-title">{t('recording.reconnecting')}</span>
            <span>{t('recording.reconnectingHelp')}</span>
          </div>
        )
      )}
      {battery && (
        <div className="alert alert-warning margin-x" role="status">
          <span className="alert-title">{t('recording.battery', { percent: battery.pct })}</span>
          <span>
            {battery.restante ? t('recording.batteryRemaining', { remaining: battery.restante }) : ''}{t('recording.batteryHelp')}
          </span>
        </div>
      )}
      <div className="m-section gap-5 top-6">
        <span className="m-timer" aria-label={t('recording.audioTime')}>
          {clock(audioMs)}
        </span>
        <Meter level={session?.nivel ?? 0} paused={paused || !session} />
      </div>
      <div className="m-section m-fill m-scroll">
        <div className="row-between">
          <span className="kicker">{t('recording.markers')}</span>
          <span className="text-muted text-12">
            {markers.length}
          </span>
        </div>
        <ul className="markers">
          {markers.map((m) => (
            <li key={m.client_id} data-empty={m.note ? undefined : ''}>
              <span className="timecode">{clock(m.at_ms)}</span>
              <span>{m.note ?? t('common.marker')}</span>
            </li>
          ))}
        </ul>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
      </div>
      {annotating && <MarkerNote marker={annotating} onDone={() => setAnnotating(null)} />}
      <div className="m-cells">
        {paused ? (
          <button type="button" className="m-cell" aria-pressed="true" onClick={() => run(() => bridge.resume())}>
            <PlayIcon />
            {t('recording.resume')}
          </button>
        ) : (
          <button type="button" className="m-cell" aria-pressed="false" onClick={() => run(() => bridge.pause())}>
            <PauseIcon />
            {t('recording.pause')}
          </button>
        )}
        <button type="button" className="m-cell" disabled={!session} onClick={mark}>
          <MarkerIcon />
          {t('common.marker')}
        </button>
        <button type="button" className="m-cell m-cell-stop" disabled={!session} onClick={stop}>
          <StopIcon />
          {t('recording.stop')}
        </button>
      </div>
      <div className="m-footer" />
      {state.folha && <RecordingSaved sheet={state.folha} />}
    </div>
  )
}
