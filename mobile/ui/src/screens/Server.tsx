import { useT } from '../i18n'
import { useEffect, useState } from 'react'
import { Brand } from '../app/Brand'
import { errorMessage, useBridge } from '../bridge/bridge'
import type { Found } from '../bridge/types'

/** How long the network search lasts. */
export const SEARCH_SECONDS = 10

/** First run: finds the server on the Wi-Fi network through mDNS. */
export function Server({ go }: { go: (route: string) => void }) {
  const t = useT()
  const bridge = useBridge()
  const [found, setFound] = useState<Found[]>([])
  const [searching, setSearching] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [connecting, setConnecting] = useState<string | null>(null)

  const [round, setRound] = useState(0)

  useEffect(() => {
    let active = true
    bridge
      .discover(SEARCH_SECONDS)
      .then((list) => active && setFound(list))
      .catch((e) => active && setError(errorMessage(e)))
      .finally(() => active && setSearching(false))
    return () => {
      active = false
    }
  }, [bridge, round])

  function search() {
    setSearching(true)
    setError(null)
    setRound((n) => n + 1)
  }

  async function connect(server: Found) {
    setConnecting(server.url)
    setError(null)
    try {
      await bridge.connectDiscovered(server.url, server.ca_sha256)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setConnecting(null)
    }
  }

  return (
    <div className="m-body">
      <div className="m-section top-7 gap-2">
        <Brand large />
        <h1 className="m-title margin-top-5">{t('server.title')}</h1>
        <p className="no-margin text-15">{t('server.help')}</p>
      </div>
      <div className="m-section m-fill">
        <div className="row-between">
          <span className="kicker">{t('server.found')}</span>
          {searching ? (
            <span className="badge badge-progress">{t('server.searching')}</span>
          ) : (
            <button type="button" className="btn btn-ghost btn-sm" onClick={search}>
              {t('server.searchAgain')}
            </button>
          )}
        </div>
        {found.length > 0 ? (
          <ul className="m-rows">
            {found.map((server) => (
              <li className="m-row" key={server.url}>
                <span className="m-row-title">{server.nome}</span>
                <span className="m-row-sub">{new URL(server.url).host}</span>
                <span className="m-row-end">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={connecting !== null}
                    onClick={() => connect(server)}
                  >
                    {connecting === server.url ? t('server.connecting') : t('server.connect')}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          !searching && (
            <p className="text-muted no-margin text-14">{t('server.empty')}</p>
          )
        )}
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="m-section gap-2">
        <button
          type="button"
          className="btn btn-secondary button-start"
          onClick={() => go('/scan-code')}
        >
          {t('server.scan')}
        </button>
        <button
          type="button"
          className="btn btn-ghost button-start"
          onClick={() => go('/server/address')}
        >
          {t('server.address')}
        </button>
      </div>
    </div>
  )
}
