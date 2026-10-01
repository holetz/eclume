import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api, type Schemas } from '../../api/client'
import { unwrap } from '../../api/problem'
import { pollWhile } from '../../app/polling'
import { TOKENS_KEY } from '../tokens/scopes'

type PairingCode = Schemas['PairingCode']

const PAIRING_POLL_MS = 3000

/** Quanto faltava quando a resposta chegou, medido no relógio do servidor, e o `performance.now()` de então. */
interface CountdownAnchor {
  expiresInMs: number
  at: number
}

export interface Pairing {
  code: PairingCode
  anchor: CountdownAnchor
}

/** Um código vale 10 minutos (holetz/eclume#35). */
const PAIRING_TTL_MS = 10 * 60_000

/**
 * A âncora da contagem: `expires_at` menos o `Date` da resposta (o relógio do servidor), contada a
 * partir do `performance.now()`. Assim a contagem não depende do relógio do computador estar certo.
 * O `Date` só tem segundos e o servidor o renova uma vez por segundo, então pode ficar até ~2 s
 * atrás: a validade nunca passa dos 10 minutos do código.
 */
export function anchorFrom(expiresAt: string, dateHeader: string | null, now: number = performance.now()): CountdownAnchor {
  const serverNow = dateHeader ? Date.parse(dateHeader) : Number.NaN
  const base = Number.isNaN(serverNow) ? Date.now() : serverNow
  return { expiresInMs: Math.min(Date.parse(expiresAt) - base, PAIRING_TTL_MS), at: now }
}

/** Gera um código de vínculo. Um código novo anula o anterior (holetz/eclume#35). */
export function useCreatePairingCode() {
  return useMutation({
    mutationFn: async (): Promise<Pairing> => {
      const result = await api.POST('/api/v1/devices/pairing-codes')
      const code = await unwrap(Promise.resolve(result))
      return { code, anchor: anchorFrom(code.expires_at, result.response.headers.get('Date')) }
    },
  })
}

function remainingMs(anchor: CountdownAnchor, now: number = performance.now()): number {
  return Math.max(0, anchor.expiresInMs - (now - anchor.at))
}

/**
 * `m:ss`, arredondado para baixo: o header `Date` só tem segundos, e arredondar para cima mostraria
 * "10:01" num código de 10 minutos.
 */
export function formatCountdown(ms: number): string {
  const total = Math.floor(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** O tempo que falta, recalculado a cada segundo e parado quando zera. */
function useCountdown(anchor: CountdownAnchor | null): number {
  const [left, setLeft] = useState(() => (anchor ? remainingMs(anchor) : 0))
  const [current, setCurrent] = useState(anchor)
  if (current !== anchor) {
    setCurrent(anchor)
    setLeft(anchor ? remainingMs(anchor) : 0)
  }

  useEffect(() => {
    if (!anchor) return
    const timer = setInterval(() => {
      const value = remainingMs(anchor)
      setLeft(value)
      if (value === 0) clearInterval(timer)
    }, 1000)
    return () => clearInterval(timer)
  }, [anchor])

  return left
}

/**
 * Consulta o estado do código a cada 3 s enquanto ele está `pending` e a contagem não zerou. No
 * `used`, atualiza as listas de tokens, onde o aparelho novo aparece.
 */
function usePairingStatus(id: string, counting: boolean) {
  const queryClient = useQueryClient()
  const status = useQuery({
    queryKey: ['pairing-codes', id],
    queryFn: () =>
      unwrap(api.GET('/api/v1/devices/pairing-codes/{pairing_code_id}', { params: { path: { pairing_code_id: id } } })),
    enabled: counting,
    refetchInterval: pollWhile((data: PairingCode | undefined) => !data || data.status === 'pending', PAIRING_POLL_MS),
  })
  const used = status.data?.status === 'used'

  useEffect(() => {
    if (used) queryClient.invalidateQueries({ queryKey: TOKENS_KEY })
  }, [used, queryClient])

  return status.data
}

/** Os tokens de aparelho (`GET /tokens?kind=device`), sob a chave das listas de tokens. */
export function useDeviceTokens() {
  return useQuery({
    queryKey: [...TOKENS_KEY, 'device'],
    queryFn: () => unwrap(api.GET('/api/v1/tokens', { params: { query: { kind: 'device', limit: 100 } } })),
  })
}

type PairingState =
  | { phase: 'pending'; left: string; announce: string }
  | { phase: 'expired'; announce: string }
  | { phase: 'used'; deviceName: string | null; announce: string }

/** A contagem e o estado de um código: pendente com o tempo que falta, vencido ou já usado. */
export function usePairingState(pairing: Pairing): PairingState {
  const left = useCountdown(pairing.anchor)
  const polled = usePairingStatus(pairing.code.id, left > 0)
  const devices = useDeviceTokens()
  const status = polled?.status ?? 'pending'
  if (status === 'used') {
    const device = devices.data?.items.find((token) => token.id === polled?.token_id)
    return { phase: 'used', deviceName: device?.name ?? null, announce: 'Pareado' }
  }
  if (status === 'expired' || left === 0) return { phase: 'expired', announce: 'Código vencido' }
  // O leitor de tela só ouve o último minuto, não cada segundo.
  return { phase: 'pending', left: formatCountdown(left), announce: left <= 60_000 ? 'Falta 1 minuto' : '' }
}
