import { useEffect, useState } from 'react'
import { usePonte } from '../ponte/ponte'
import type { EstadoApp } from '../ponte/tipos'

/** O `EstadoApp` atual: lido uma vez e depois pelo evento `estado`. */
export function useEstadoApp(): EstadoApp | null {
  const ponte = usePonte()
  const [estado, setEstado] = useState<EstadoApp | null>(null)

  useEffect(() => {
    let ativo = true
    let cancelar: (() => void) | undefined
    ponte
      .estado()
      .then((lido) => ativo && setEstado(lido))
      .catch(() => {})
    ponte.ouvirEstado((novo) => ativo && setEstado(novo)).then((fn) => {
      if (ativo) cancelar = fn
      else fn()
    })
    return () => {
      ativo = false
      cancelar?.()
    }
  }, [ponte])

  return estado
}
