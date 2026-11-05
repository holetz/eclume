import { useState } from 'react'
import { rate } from '../app/formats'
import { errorMessage, useBridge } from '../bridge/bridge'
import type { NetworkState } from '../bridge/types'

/** The `.m-net` banner: on eclume's network, off it or syncing. */
export function NetworkBanner({ network, pending }: { network: NetworkState; pending: number }) {
  const bridge = useBridge()
  const [error, setError] = useState<string | null>(null)

  async function sync() {
    setError(null)
    try {
      await bridge.syncNow()
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  switch (network.estado) {
    case 'syncing':
      return (
        <div className="m-net m-net-detail">
          <div className="row-between">
            <span className="status-line" data-status="syncing">
              Sincronizando {network.i} de {network.n}
            </span>
            <span className="text-muted mono text-12">
              {network.pct} %{network.bytes_s > 0 ? ` · ${rate(network.bytes_s)}` : ''}
            </span>
          </div>
          <progress className="progress" value={network.pct} max={100} aria-label="Andamento do envio" />
        </div>
      )
    case 'on_network':
      return (
        <div className="m-net">
          <span className="status-line" data-status="synced">
            Na rede do eclume
          </span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={sync}>
            Sincronizar agora
          </button>
          {error && <span className="error-text">{error}</span>}
        </div>
      )
    case 'ca_mismatch':
      return (
        <div className="m-net">
          <span className="status-line" data-status="away">
            O certificado do servidor mudou
          </span>
          <span className="text-muted text-13">
            Nada sobe até parear de novo
          </span>
        </div>
      )
    default:
      return (
        <div className="m-net">
          <span className="status-line" data-status="away">
            Fora da rede do eclume
          </span>
          {pending > 0 && (
            <span className="text-muted text-13">
              {pending} aguardando
            </span>
          )}
        </div>
      )
  }
}
