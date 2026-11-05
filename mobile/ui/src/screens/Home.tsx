import { useT, t } from '../i18n'
import { useEffect, useRef, useState } from 'react'
import { size } from '../app/formats'
import { record as recordFlow, recordAfterBattery, type RecordStep } from '../app/record'
import { SettingsIcon } from '../app/Icons'
import { Brand } from '../app/Brand'
import { errorMessage, useBridge } from '../bridge/bridge'
import type { AppState, DeviceStatus, LocalRecording } from '../bridge/types'
import { NetworkBanner } from './NetworkBanner'
import { PhoneList } from './PhoneList'

/** The summary to the right of the phone list's heading. */
function summary(state: AppState): string {
  if (state.pendentes === 0) return t('home.allSynced')
  if (state.rede.estado === 'away') return t('home.syncOnWifi')
  return t('home.waiting', { count: state.pendentes })
}

/**
 * Home: the network banner, the Record button and this phone's recordings. Each new `recordRequest`
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
  const t = useT()
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
      setError(step.message)
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
          aria-label={t('home.settings')}
          onClick={() => go('/settings')}
        >
          <SettingsIcon />
        </button>
      </div>
      <NetworkBanner network={state.rede} pending={state.pendentes} />
      {device && !device.notifications && (
        <div className="alert alert-warning alert-on-top" role="status">
          <span className="alert-title">{t('home.notificationsBlocked')}</span>
          <span>{t('home.notificationsHelp')}</span>
          <button
            type="button"
            className="btn btn-secondary btn-sm align-start margin-top-2"
            onClick={openAppSettings}
          >
            {t('home.openSettings')}
          </button>
        </div>
      )}
      {storage && (
        <div className="alert alert-warning alert-on-top" role="status">
          <span className="alert-title">{t('home.storageLow')}</span>
          <span>{t('home.recordingRemaining', { remaining: storage.restante.replace(/^cerca/, 'Cerca') })}</span>
          {storage.sincronizadas_bytes > 0 && (
            <button
              type="button"
              className="btn btn-secondary btn-sm align-start margin-top-2"
              onClick={deleteSynced}
            >
              {t('home.deleteSynced', { size: size(storage.sincronizadas_bytes) })}
            </button>
          )}
        </div>
      )}
      <div className="m-section">
        <button type="button" className="m-rec" aria-pressed="false" disabled={busy} onClick={record}>
          <span>
            <span className="m-rec-label">{t('home.record')}</span>
            <span className="m-rec-sub">{t('home.lockScreenHint')}</span>
          </span>
        </button>
        {explainingBattery && (
          <div className="alert alert-info" role="alertdialog" aria-label={t('home.batteryTitle')}>
            <span className="alert-title">{t('home.batteryTitle')}</span>
            <span>
              {t('home.batteryHelp')}
            </span>
            <div className="two-columns margin-top-2">
              <button type="button" className="btn btn-primary" onClick={() => continueFromBattery(true)}>
                {t('home.allow')}
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => continueFromBattery(false)}>
                {t('home.notNow')}
              </button>
            </div>
          </div>
        )}
        {error && (
          <p className="error-text" role="alert">
            {noMicrophone ? t('home.noMicrophone') : error}
          </p>
        )}
        {noMicrophone && (
          <button type="button" className="btn btn-secondary" onClick={openAppSettings}>
            {t('home.openSettings')}
          </button>
        )}
      </div>
      <PhoneList recordings={recordings} summary={summary(state)} open={(id) => go(`/recording/${id}`)} />
    </div>
  )
}
