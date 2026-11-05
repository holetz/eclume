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
 * the list. Marcador marks right away; the note comes after, optional. After Parar, the saved-recording
 * sheet asks for the title and the agenda type.
 */
export function Recording({ state }: { state: AppState }) {
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
          {paused ? 'Pausado' : 'Gravando'}
        </span>
        {state.espaco_livre && (
          <span className="text-muted text-13">
            Espaço livre: {state.espaco_livre}
          </span>
        )}
      </div>
      {state.conexao.fase === 'sem_credencial' && (
        <div className="alert alert-warning margin-x" role="status">
          <span className="alert-title">Entre de novo para sincronizar</span>
          <span>A gravação segue no celular; ela sobe depois que você entrar.</span>
        </div>
      )}
      {session?.silenciada ? (
        <div className="alert alert-warning margin-x" role="status">
          <span className="alert-title">Silenciado pelo sistema</span>
          <span>Uma chamada ou o sistema tomou o microfone. A gravação segue e volta sozinha.</span>
        </div>
      ) : (
        session?.microfone === 'reconectando' && (
          <div className="alert alert-warning margin-x" role="status">
            <span className="alert-title">Microfone reconectando</span>
            <span>O microfone caiu. A gravação segue no mesmo arquivo enquanto ele volta.</span>
          </div>
        )
      )}
      {battery && (
        <div className="alert alert-warning margin-x" role="status">
          <span className="alert-title">Bateria em {battery.pct} %</span>
          <span>
            {battery.restante ? `Dá para ${battery.restante}. ` : ''}A gravação fica salva se o celular
            desligar.
          </span>
        </div>
      )}
      <div className="m-section gap-5 top-6">
        <span className="m-timer" aria-label="Tempo de áudio">
          {clock(audioMs)}
        </span>
        <Meter level={session?.nivel ?? 0} paused={paused || !session} />
      </div>
      <div className="m-section m-fill m-scroll">
        <div className="row-between">
          <span className="kicker">Marcadores</span>
          <span className="text-muted text-12">
            {markers.length}
          </span>
        </div>
        <ul className="markers">
          {markers.map((m) => (
            <li key={m.client_id} data-empty={m.note ? undefined : ''}>
              <span className="timecode">{clock(m.at_ms)}</span>
              <span>{m.note ?? 'Marcador'}</span>
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
            Continuar
          </button>
        ) : (
          <button type="button" className="m-cell" aria-pressed="false" onClick={() => run(() => bridge.pause())}>
            <PauseIcon />
            Pausar
          </button>
        )}
        <button type="button" className="m-cell" disabled={!session} onClick={mark}>
          <MarkerIcon />
          Marcador
        </button>
        <button type="button" className="m-cell m-cell-stop" disabled={!session} onClick={stop}>
          <StopIcon />
          Parar
        </button>
      </div>
      <div className="m-footer" />
      {state.folha && <RecordingSaved sheet={state.folha} />}
    </div>
  )
}
