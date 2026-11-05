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
      <Back label="Início" onBack={() => go('/')} />
      <div className="m-section no-top">
        <h1 className="m-title">Configurações</h1>
      </div>
      {data && preferences && (
        <div className="m-section m-fill gap-3 top-1">
          <div className="m-group">
            <span className="kicker">Servidor</span>
            <ul className="m-rows">
              <Row title="Endereço">
                <span className="mono text-muted text-14">
                  {data.servidor ? new URL(data.servidor).host : '—'}
                </span>
              </Row>
            </ul>
          </div>
          <div className="m-group">
            <span className="kicker">Sincronização</span>
            <ul className="m-rows">
              <Row title="Sincronizar automaticamente" sub="Na rede do servidor">
                <Switch
                  label="Sincronizar automaticamente"
                  on={preferences.sync_auto}
                  onToggle={(sync_auto) => change({ sync_auto })}
                />
              </Row>
              <Row title="Só no Wi‑Fi do servidor" sub="Nunca usa dados móveis">
                <Switch label="Só no Wi‑Fi do servidor" on disabled />
              </Row>
            </ul>
          </div>
          <div className="m-group">
            <span className="kicker">Áudio</span>
            <ul className="m-rows">
              <Row title="Qualidade" sub={`Cerca de ${MB_PER_HOUR[preferences.qualidade]} MB por hora`}>
                <div className="seg" role="radiogroup" aria-label="Qualidade">
                  {(['padrao', 'alta'] as const).map((q) => (
                    <label className="seg-opt" key={q}>
                      <input
                        type="radio"
                        name="quality"
                        checked={preferences.qualidade === q}
                        onChange={() => change({ qualidade: q })}
                      />
                      {q === 'padrao' ? 'Padrão' : 'Alta'}
                    </label>
                  ))}
                </div>
              </Row>
            </ul>
          </div>
          {device && (
            <div className="m-group">
              <span className="kicker">Gravação</span>
              <ul className="m-rows">
                <Row
                  title="Gravar com a tela bloqueada"
                  sub={
                    device.batteryExemption === 'concedida'
                      ? 'Sem otimização de bateria'
                      : 'A otimização de bateria pode parar a gravação'
                  }
                >
                  {device.batteryExemption !== 'concedida' && (
                    <button type="button" className="btn btn-secondary btn-sm" onClick={requestExemption}>
                      Permitir
                    </button>
                  )}
                </Row>
              </ul>
            </div>
          )}
          <div className="m-group">
            <span className="kicker">Armazenamento</span>
            <ul className="m-rows">
              <Row title="Excluir depois de sincronizar" sub={`Mantém os últimos ${data.reter_dias} dias`}>
                <Switch
                  label="Excluir depois de sincronizar"
                  on={preferences.excluir_sincronizadas}
                  onToggle={(excluir_sincronizadas) => change({ excluir_sincronizadas })}
                />
              </Row>
              <Row title="Neste celular">
                <span className="text-muted text-14">
                  {size(data.uso_bytes)}
                  {freeSpace ? ` · ${freeSpace.replace(/^cerca de /, '')} livres` : ''}
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
          <div className="alert alert-warning" role="alertdialog" aria-label="Sair e esquecer o servidor">
            <span className="alert-title">Sair e esquecer o servidor?</span>
            <span>
              {pending > 0
                ? `${pending === 1 ? '1 gravação aguarda' : `${pending} gravações aguardam`} o sync: elas ficam no celular e sobem no próximo servidor pareado. `
                : ''}
              Desvincule este aparelho na web, em Minhas configurações → App móvel: o acesso dele não se
              revoga sozinho.
            </span>
            <div className="two-columns margin-top-2">
              <button type="button" className="btn btn-secondary btn-danger" onClick={signOut}>
                Sair
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setConfirmingSignOut(false)}>
                Cancelar
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="btn btn-secondary btn-danger button-start"
            onClick={() => setConfirmingSignOut(true)}
          >
            Sair e esquecer o servidor
          </button>
        )}
        <span className="text-muted text-12">
          eclume para Android · v{data?.versao ?? ''}
        </span>
        {update && (
          <button type="button" className="btn btn-primary button-start" onClick={installUpdate}>
            Nova versão disponível · v{update.versao}
          </button>
        )}
      </div>
    </div>
  )
}
