import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api, type Schemas } from '../../api/client'
import { unwrap } from '../../api/problem'
import { pollWhile } from '../../app/polling'
import { TOKENS_KEY } from '../tokens/scopes'

type PairingCode = Schemas['PairingCode']

const PAIRING_POLL_MS = 3000

/** How much time was left when the response arrived, measured on the server's clock, and the `performance.now()` at that moment. */
interface CountdownAnchor {
  expiresInMs: number
  at: number
}

export interface Pairing {
  code: PairingCode
  anchor: CountdownAnchor
}

/** A code is valid for 10 minutes (holetz/eclume#35). */
const PAIRING_TTL_MS = 10 * 60_000

/**
 * The countdown anchor: `expires_at` minus the response's `Date` (the server's clock), counted from
 * `performance.now()`. That way the countdown does not depend on the computer's clock being right.
 * `Date` only has seconds and the server renews it once per second, so it can lag up to ~2 s
 * behind: the expiry never goes past the code's 10 minutes.
 */
export function anchorFrom(expiresAt: string, dateHeader: string | null, now: number = performance.now()): CountdownAnchor {
  const serverNow = dateHeader ? Date.parse(dateHeader) : Number.NaN
  const base = Number.isNaN(serverNow) ? Date.now() : serverNow
  return { expiresInMs: Math.min(Date.parse(expiresAt) - base, PAIRING_TTL_MS), at: now }
}

/** Generates a pairing code. A new code voids the previous one (holetz/eclume#35). */
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
 * `m:ss`, rounded down: the `Date` header only has seconds, and rounding up would show "10:01" on a
 * 10-minute code.
 */
export function formatCountdown(ms: number): string {
  const total = Math.floor(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** The time left, recomputed every second and stopped when it reaches zero. */
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
 * Polls the code state every 3 s while it is `pending` and the countdown has not reached zero. On
 * `used`, it refreshes the token lists, where the new device appears.
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

/** The device tokens (`GET /tokens?kind=device`), under the token lists key. */
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

/** A code's countdown and state: pending with the time left, expired or already used. */
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
  // The screen reader only hears the last minute, not every second.
  return { phase: 'pending', left: formatCountdown(left), announce: left <= 60_000 ? 'Falta 1 minuto' : '' }
}
