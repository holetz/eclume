// Um ritmo de polling para toda espera de job (biblioteca, gravação, resumo, chats, pré-visualização,
// código de vínculo): o intervalo inicial nos primeiros 2 min, depois dobrando a cada minuto até 30 s,
// e nada com a leitura em erro. Voltar para a aba ou a rede voltar recomeça do ritmo inicial; a
// releitura no foco e o `refetchOnReconnect` retomam a consulta que parou no erro.
import { focusManager, onlineManager } from '@tanstack/react-query'

export const GROW_AFTER_MS = 2 * 60_000
const STEP_MS = 60_000
export const MAX_POLL_MS = 30_000

/** O que o helper lê da consulta: a mesma forma do `Query` do React Query. */
interface PolledQuery<T> {
  queryHash: string
  state: { data: T | undefined; status: string }
}

const waitingSince = new Map<string, number>()
let restartedAt = 0

function restart() {
  restartedAt = Date.now()
}
focusManager.subscribe((focused) => focused && restart())
onlineManager.subscribe((online) => online && restart())

/** O intervalo depois de `elapsed` ms de espera, a partir de `initialMs`. */
export function pollDelay(initialMs: number, elapsed: number): number {
  if (elapsed < GROW_AFTER_MS) return initialMs
  const doublings = 1 + Math.floor((elapsed - GROW_AFTER_MS) / STEP_MS)
  return Math.min(MAX_POLL_MS, initialMs * 2 ** doublings)
}

/**
 * O `refetchInterval` de uma consulta que espera um job: relê enquanto `isWaiting(data)` vale,
 * no ritmo de `pollDelay`, e para com a consulta em `error`.
 */
export function pollWhile<T>(isWaiting: (data: T | undefined) => boolean, initialMs: number) {
  return (query: PolledQuery<T>): number | false => {
    if (query.state.status === 'error' || !isWaiting(query.state.data)) {
      waitingSince.delete(query.queryHash)
      return false
    }
    const now = Date.now()
    const since = Math.max(waitingSince.get(query.queryHash) ?? now, restartedAt)
    waitingSince.set(query.queryHash, since)
    return pollDelay(initialMs, now - since)
  }
}
