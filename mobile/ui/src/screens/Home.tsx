import { useEffect, useRef, useState } from 'react'
import { size } from '../app/formats'
import { record as recordFlow, recordAfterBattery, type RecordStep, NO_MICROPHONE } from '../app/record'
import { SettingsIcon } from '../app/Icons'
import { Brand } from '../app/Brand'
import { errorMessage, useBridge } from '../bridge/bridge'
import type { AppState, DeviceStatus, LocalRecording } from '../bridge/types'
import { NetworkBanner } from './NetworkBanner'
import { PhoneList } from './PhoneList'

/** The summary to the right of the phone list's heading. */
function summary(state: AppState): string {
  if (state.pendentes === 0) return 'Tudo sincronizado'
  if (state.rede.estado === 'away') return 'Sincroniza no Wi‑Fi do servidor'
  return state.pendentes === 1 ? '1 aguardando' : `${state.pendentes} aguardando`
}

/**
 * Home: the network banner, the Gravar button and this phone's recordings. Each new `recordRequest`
 * (the launcher icon's record-now shortcut) runs the button's flow, once the device has been read.
 */
export function Home({
  state,
  go,
  recordRequest = 0,
}: {
  state: AppState
  go: (route: string) => void
  recordRequest?: number
}) {
  const bridge = useBridge()
  const [recordings, setRecordings] = useState<LocalRecording[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [noMicrophone, setNoMicrophone] = useState(false)
  const [device, setDevice] = useState<DeviceStatus | null>(null)
  const [deviceRead, setDeviceRead] = useState(false)
  const [explainingBattery, setExplainingBattery] = useState(false)
  const requestServed = useRef(0)

  useEffect(() => {
    let active = true
    bridge
      .device()
      .then((read) => active && setDevice(read))
      .catch(() => {})
      .finally(() => active && setDeviceRead(true))
    return () => {
      active = false
    }
  }, [bridge])

  // The list follows the state: on each change of the pending count or the network, it reads again.
  const key = `${state.pendentes}|${state.rede.estado}|${state.folha?.id ?? ''}`
  useEffect(() => {
    let active = true
    bridge
      .recordings()
      .then((list) => active && setRecordings(list))
      .catch(() => {})
    return () => {
      active = false
    }
  }, [bridge, key])

  function show(step: RecordStep) {
    if (step.step === 'no_microphone') {
      setNoMicrophone(true)
      setError(NO_MICROPHONE)
    } else if (step.step === 'explain_battery') {
      setExplainingBattery(true)
    } else if (step.step === 'error') {
      setError(step.message)
    }
  }

  async function record() {
    setBusy(true)
    setError(null)
    setNoMicrophone(false)
    const step = await recordFlow(bridge, device, (notifications) =>
      setDevice((current) => current && { ...current, notifications }),
    )
    show(step)
    setBusy(false)
  }

  async function continueFromBattery(ask: boolean) {
    setExplainingBattery(false)
    setBusy(true)
    const result = await recordAfterBattery(bridge, ask)
    if (result.device) setDevice(result.device)
    show(result.step)
    setBusy(false)
  }

  // The record-now shortcut: the button's flow, once per request.
  useEffect(() => {
    if (!deviceRead || recordRequest <= requestServed.current) return
    requestServed.current = recordRequest
    void record()
    // `record` reads this render's device; the request is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordRequest, deviceRead])

  async function openAppSettings() {
    try {
      await bridge.openAppSettings()
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  async function deleteSynced() {
    try {
      await bridge.deleteSynced()
      setRecordings(await bridge.recordings())
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  const storage = state.avisos.armazenamento
  return (
    <div className="m-body">
      <div className="m-top">
        <Brand />
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          aria-label="Configurações"
          onClick={() => go('/settings')}
        >
          <SettingsIcon />
        </button>
      </div>
      <NetworkBanner network={state.rede} pending={state.pendentes} />
      {device && !device.notifications && (
        <div className="alert alert-warning alert-on-top" role="status">
          <span className="alert-title">Notificações bloqueadas</span>
          <span>Sem elas, a gravação não aparece na tela bloqueada e você não fica sabendo se ela parar.</span>
          <button
            type="button"
            className="btn btn-secondary btn-sm align-start margin-top-2"
            onClick={openAppSettings}
          >
            Abrir configurações do app
          </button>
        </div>
      )}
      {storage && (
        <div className="alert alert-warning alert-on-top" role="status">
          <span className="alert-title">Armazenamento quase cheio</span>
          <span>{storage.restante.replace(/^cerca/, 'Cerca')} de gravação.</span>
          {storage.sincronizadas_bytes > 0 && (
            <button
              type="button"
              className="btn btn-secondary btn-sm align-start margin-top-2"
              onClick={deleteSynced}
            >
              Excluir sincronizadas · {size(storage.sincronizadas_bytes)}
            </button>
          )}
        </div>
      )}
      <div className="m-section">
        <button type="button" className="m-rec" aria-pressed="false" disabled={busy} onClick={record}>
          <span>
            <span className="m-rec-label">Gravar</span>
            <span className="m-rec-sub">Continua gravando com a tela bloqueada</span>
          </span>
        </button>
        {explainingBattery && (
          <div className="alert alert-info" role="alertdialog" aria-label="Gravar com a tela bloqueada">
            <span className="alert-title">Gravar com a tela bloqueada</span>
            <span>
              A otimização de bateria do Android pode parar a gravação com a tela apagada. Permita que o eclume
              funcione em segundo plano.
            </span>
            <div className="two-columns margin-top-2">
              <button type="button" className="btn btn-primary" onClick={() => continueFromBattery(true)}>
                Permitir
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => continueFromBattery(false)}>
                Agora não
              </button>
            </div>
          </div>
        )}
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        {noMicrophone && (
          <button type="button" className="btn btn-secondary" onClick={openAppSettings}>
            Abrir configurações do app
          </button>
        )}
      </div>
      <PhoneList recordings={recordings} summary={summary(state)} open={(id) => go(`/recording/${id}`)} />
    </div>
  )
}
