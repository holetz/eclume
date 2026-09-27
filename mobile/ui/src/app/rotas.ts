import { useCallback, useEffect, useState } from 'react'

function lerRota(): string {
  return window.location.hash.replace(/^#/, '') || '/'
}

/** A rota do hash (`#/configuracoes`) e a função que navega. */
export function useRota(): [string, (rota: string) => void] {
  const [rota, setRota] = useState(lerRota)

  useEffect(() => {
    const aoMudar = () => setRota(lerRota())
    window.addEventListener('hashchange', aoMudar)
    return () => window.removeEventListener('hashchange', aoMudar)
  }, [])

  const ir = useCallback((destino: string) => {
    window.location.hash = destino
    setRota(destino)
  }, [])

  return [rota, ir]
}
