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
 * A faixa de conexão no topo do shell: sem rede, ou com `/me` falhando sobre a sessão em cache.
 * Consultas e mutações já pausam sem rede e retomam na volta (o `networkMode` padrão); a faixa só
 * dá o motivo e, com rede mas servidor fora, relê `/me` até ele voltar, a cada 10 s e dobrando até 60 s.
 */
export function ConnectionBanner() {
  const online = useOnline()
  const me = useMe()
  const serverDown = me.isError && !!me.data
  const { refetch } = me

  useEffect(() => {
    if (!online || !serverDown) return
    // Servidor fora: 10 s, dobrando a cada tentativa que falha até 60 s.
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
      Sem conexão com o servidor. O que está na tela pode estar desatualizado; tentando de novo…
    </p>
  )
}
