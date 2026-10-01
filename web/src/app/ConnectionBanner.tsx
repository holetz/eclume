import { onlineManager } from '@tanstack/react-query'
import { useEffect, useSyncExternalStore } from 'react'
import { useMe } from './session'

const RETRY_MS = 10_000

function useOnline() {
  return useSyncExternalStore(
    (notify) => onlineManager.subscribe(notify),
    () => onlineManager.isOnline(),
  )
}

/**
 * A faixa de conexão no topo do shell: sem rede, ou com `/me` falhando sobre a sessão em cache.
 * Consultas e mutações já pausam sem rede e retomam na volta (o `networkMode` padrão); a faixa só
 * dá o motivo e, com rede mas servidor fora, relê `/me` até ele voltar.
 */
export function ConnectionBanner() {
  const online = useOnline()
  const me = useMe()
  const serverDown = me.isError && !!me.data
  const { refetch } = me

  useEffect(() => {
    if (!online || !serverDown) return
    const timer = window.setInterval(() => refetch(), RETRY_MS)
    return () => window.clearInterval(timer)
  }, [online, serverDown, refetch])

  if (online && !serverDown) return null
  return (
    <p className="alert alert-warning" role="status">
      Sem conexão com o servidor. O que está na tela pode estar desatualizado; tentando de novo…
    </p>
  )
}
