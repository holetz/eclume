import { useT } from '../i18n'
import { useState } from 'react'
import { rate } from '../app/formats'
import { errorMessage, useBridge } from '../bridge/bridge'
import type { NetworkState } from '../bridge/types'

/** The `.m-net` banner: on eclume's network, off it or syncing. */
export function NetworkBanner({ network, pending }: { network: NetworkState; pending: number }) {
  const t = useT()
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
              {t('network.syncing', { current: network.i, total: network.n })}
            </span>
            <span className="text-muted mono text-12">
              {network.pct} %{network.bytes_s > 0 ? ` · ${rate(network.bytes_s)}` : ''}
            </span>
          </div>
          <progress className="progress" value={network.pct} max={100} aria-label={t('network.progress')} />
        </div>
      )
    case 'on_network':
      return (
        <div className="m-net">
          <span className="status-line" data-status="synced">
            {t('network.onNetwork')}
          </span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={sync}>
            {t('network.syncNow')}
          </button>
          {error && <span className="error-text">{error}</span>}
        </div>
      )
    case 'ca_mismatch':
      return (
        <div className="m-net">
          <span className="status-line" data-status="away">
            {t('network.certificateChanged')}
          </span>
          <span className="text-muted text-13">
            {t('network.pairAgain')}
          </span>
        </div>
      )
    default:
      return (
        <div className="m-net">
          <span className="status-line" data-status="away">
            {t('network.away')}
          </span>
          {pending > 0 && (
            <span className="text-muted text-13">
              {t('network.waiting', { count: pending })}
            </span>
          )}
        </div>
      )
  }
}
