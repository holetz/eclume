import { useT } from '../i18n'
import { useEffect, useState, type ReactNode } from 'react'
import { size } from '../app/formats'
import { Back } from '../app/Back'
import { errorMessage, useBridge } from '../bridge/bridge'
import type { AppSettings, DeviceStatus, Preferences, Quality, Update } from '../bridge/types'

const MB_PER_HOUR: Record<Quality, number> = { padrao: 11, alta: 22 }

function Row({ title, sub, children }: { title: string; sub?: string; children?: ReactNode }) {
  return (
    <li className="m-row m-row-tall">
      <span className="m-row-title m-row-title-body">
        {title}
      </span>
      {sub && <span className="m-row-sub">{sub}</span>}
      <span className="m-row-end">{children}</span>
    </li>
  )
}

function Switch({
  label,
  on,
  disabled,
  onToggle,
}: {
  label: string
  on: boolean
  disabled?: boolean
  onToggle?: (on: boolean) => void
}) {
  return (
    <label className="switch">
      <input
        type="checkbox"
        aria-label={label}
        checked={on}
        disabled={disabled}
        onChange={(e) => onToggle?.(e.target.checked)}
      />
      <span className="track" />
    </label>
  )
}

/** Settings: server, sync, audio, storage, sign out and the version. */
export function Settings({ go, freeSpace }: { go: (route: string) => void; freeSpace: string | null }) {
  const t = useT()
  const bridge = useBridge()
  const [data, setData] = useState<AppSettings | null>(null)
  const [update, setUpdate] = useState<Update | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmingSignOut, setConfirmingSignOut] = useState(false)
  const [pending, setPending] = useState(0)
  const [device, setDevice] = useState<DeviceStatus | null>(null)

  useEffect(() => {
    let active = true
    bridge
      .settings()
      .then((read) => active && setData(read))
      .catch((e) => active && setError(errorMessage(e)))
    bridge
      .checkUpdate()
      .then((found) => active && setUpdate(found))
      .catch(() => {})
    bridge
      .state()
      .then((state) => active && setPending(state.pendentes))
      .catch(() => {})
    bridge
      .device()
      .then((read) => active && setDevice(read))
      .catch(() => {})
    return () => {
      active = false
    }
  }, [bridge])

  async function change(partial: Partial<Preferences>) {
    if (!data) return
    const preferences = { ...data.preferencias, ...partial }
    setData({ ...data, preferencias: preferences })
    try {
      await bridge.saveSettings(preferences)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  async function signOut() {
    try {
      await bridge.signOut()
      go('/server')
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  async function requestExemption() {
    setError(null)
    try {
      await bridge.requestBatteryExemption()
      setDevice(await bridge.device())
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  async function installUpdate() {
    setError(null)
    try {
      await bridge.update()
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  const preferences = data?.preferencias
  return (
    <div className="m-body m-scroll">
      <Back label={t('settings.home')} onBack={() => go('/')} />
      <div className="m-section no-top">
        <h1 className="m-title">{t('settings.title')}</h1>
      </div>
      {data && preferences && (
        <div className="m-section m-fill gap-3 top-1">
          <div className="m-group">
            <span className="kicker">{t('settings.server')}</span>
            <ul className="m-rows">
              <Row title={t('settings.address')}>
                <span className="mono text-muted text-14">
                  {data.servidor ? new URL(data.servidor).host : '—'}
                </span>
              </Row>
            </ul>
          </div>
          <div className="m-group">
            <span className="kicker">{t('settings.sync')}</span>
            <ul className="m-rows">
              <Row title={t('settings.autoSync')} sub={t('settings.onNetwork')}>
                <Switch
                  label={t('settings.autoSync')}
                  on={preferences.sync_auto}
                  onToggle={(sync_auto) => change({ sync_auto })}
                />
              </Row>
              <Row title={t('settings.wifiOnly')} sub={t('settings.noMobileData')}>
                <Switch label={t('settings.wifiOnly')} on disabled />
              </Row>
            </ul>
          </div>
          <div className="m-group">
            <span className="kicker">{t('settings.audio')}</span>
            <ul className="m-rows">
              <Row title={t('settings.quality')} sub={t('settings.qualityHelp', { size: size(MB_PER_HOUR[preferences.qualidade] * 1_000_000) })}>
                <div className="seg" role="radiogroup" aria-label={t('settings.quality')}>
                  {(['padrao', 'alta'] as const).map((q) => (
                    <label className="seg-opt" key={q}>
                      <input
                        type="radio"
                        name="quality"
                        checked={preferences.qualidade === q}
                        onChange={() => change({ qualidade: q })}
                      />
                      {q === 'padrao' ? t('settings.standard') : t('settings.high')}
                    </label>
                  ))}
                </div>
              </Row>
            </ul>
          </div>
          {device && (
            <div className="m-group">
              <span className="kicker">{t('settings.recording')}</span>
              <ul className="m-rows">
                <Row
                  title={t('settings.lockScreen')}
                  sub={
                    device.batteryExemption === 'concedida'
                      ? t('settings.noOptimization')
                      : t('settings.optimizationWarning')
                  }
                >
                  {device.batteryExemption !== 'concedida' && (
                    <button type="button" className="btn btn-secondary btn-sm" onClick={requestExemption}>
                      {t('settings.allow')}
                    </button>
                  )}
                </Row>
              </ul>
            </div>
          )}
          <div className="m-group">
            <span className="kicker">{t('settings.storage')}</span>
            <ul className="m-rows">
              <Row title={t('settings.deleteSynced')} sub={t('settings.retention', { count: data.reter_dias })}>
                <Switch
                  label={t('settings.deleteSynced')}
                  on={preferences.excluir_sincronizadas}
                  onToggle={(excluir_sincronizadas) => change({ excluir_sincronizadas })}
                />
              </Row>
              <Row title={t('settings.onPhone')}>
                <span className="text-muted text-14">
                  {size(data.uso_bytes)}
                  {freeSpace ? t('settings.free', { remaining: freeSpace.replace(/^cerca de /, '') }) : ''}
                </span>
              </Row>
            </ul>
          </div>
        </div>
      )}
      <div className="m-section gap-2">
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        {confirmingSignOut ? (
          <div className="alert alert-warning" role="alertdialog" aria-label={t('settings.signOut')}>
            <span className="alert-title">{t('settings.confirmSignOut')}</span>
            <span>
              {pending > 0
                ? t('settings.pending', { count: pending })
                : ''}
              {t('settings.unlink')}
            </span>
            <div className="two-columns margin-top-2">
              <button type="button" className="btn btn-secondary btn-danger" onClick={signOut}>
                {t('settings.logOut')}
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setConfirmingSignOut(false)}>
                {t('common.cancel')}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="btn btn-secondary btn-danger button-start"
            onClick={() => setConfirmingSignOut(true)}
          >
            {t('settings.signOut')}
          </button>
        )}
        <span className="text-muted text-12">
          {t('settings.version', { version: data?.versao ?? '' })}
        </span>
        {update && (
          <button type="button" className="btn btn-primary button-start" onClick={installUpdate}>
            {t('settings.update', { version: update.versao })}
          </button>
        )}
      </div>
    </div>
  )
}
