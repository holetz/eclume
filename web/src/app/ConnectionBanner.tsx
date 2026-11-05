import { useTranslation } from 'react-i18next'
import { onlineManager } from '@tanstack/react-query'
import { useEffect, useSyncExternalStore } from 'react'
import { backoffDelay } from './polling'
import { useMe } from './session'

export const RETRY_MS = 10_000
export const RETRY_MAX_MS = 60_000

function useOnline() {
  return useSyncExternalStore(
    (notify) => onlineManager.subscribe(notify),
    () => onlineManager.isOnline(),
  )
}

/**
 * The connection banner at the top of the shell: no network, or `/me` failing over the cached session.
 * Queries and mutations already pause without network and resume when it returns (the default
 * `networkMode`); the banner only gives the reason and, with network but the server down, re-reads `/me`
 * until it returns, every 10 s and doubling up to 60 s.
 */
export function ConnectionBanner() {
  const { t } = useTranslation('shell')
  const online = useOnline()
  const me = useMe()
  const serverDown = me.isError && !!me.data
  const { refetch } = me

  useEffect(() => {
    if (!online || !serverDown) return
    // Server down: 10 s, doubling on each failed attempt up to 60 s.
    let attempt = 0
    let stopped = false
    let timer: number
    const schedule = () => {
      timer = window.setTimeout(() => {
        void refetch().finally(() => {
          attempt += 1
          if (!stopped) schedule()
        })
      }, backoffDelay(RETRY_MS, RETRY_MAX_MS, attempt))
    }
    schedule()
    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
  }, [online, serverDown, refetch])

  if (online && !serverDown) return null
  return (
    <p className="alert alert-warning" role="status">
      {t('connection.offline')}
    </p>
  )
}
