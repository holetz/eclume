// One polling pace for every job wait (library, recording, summary, chats, preview, link code):
// the initial interval for the first 2 min, then doubling every minute up to 30 s, and nothing
// while the read is in error. Returning to the tab or the network coming back restarts from the
// initial pace; the refetch on focus and `refetchOnReconnect` resume the query that stopped on error.
import { focusManager, onlineManager } from '@tanstack/react-query'

export const GROW_AFTER_MS = 2 * 60_000
const STEP_MS = 60_000
export const MAX_POLL_MS = 30_000

/** What the helper reads from the query: the same shape as React Query's `Query`. */
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

/** The interval after `elapsed` ms of waiting, starting from `initialMs`. */
export function pollDelay(initialMs: number, elapsed: number): number {
  if (elapsed < GROW_AFTER_MS) return initialMs
  const doublings = 1 + Math.floor((elapsed - GROW_AFTER_MS) / STEP_MS)
  return Math.min(MAX_POLL_MS, initialMs * 2 ** doublings)
}

/**
 * The `refetchInterval` of a query waiting on a job: re-reads while `isWaiting(data)` holds,
 * at the `pollDelay` pace, and stops with the query in `error`.
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

/** The exponential backoff: `baseMs` doubling on each unchanged read, up to `maxMs`. */
export function backoffDelay(baseMs: number, maxMs: number, unchanged: number): number {
  return Math.min(maxMs, baseMs * 2 ** unchanged)
}

interface WatchedQuery<T> {
  queryHash: string
  state: { data: T | undefined; dataUpdatedAt: number }
}

/**
 * The `refetchInterval` of a service status query (admin Health): `baseMs` while the data's
 * `signature` changes, doubling on each identical read up to `maxMs`. The `signature` leaves out what
 * always fluctuates (clock, latency). Returning to the tab or the network coming back restarts from `baseMs`.
 */
export function backoffWhileUnchanged<T>(baseMs: number, maxMs: number, signature: (data: T) => string) {
  const seen = new Map<string, { at: number; sig: string; unchanged: number }>()
  let resetAt = 0
  const reset = () => {
    resetAt = Date.now()
  }
  focusManager.subscribe((focused) => focused && reset())
  onlineManager.subscribe((online) => online && reset())
  return (query: WatchedQuery<T>): number => {
    const { data, dataUpdatedAt } = query.state
    if (data === undefined) return baseMs
    const known = seen.get(query.queryHash)
    if (known?.at === dataUpdatedAt) {
      // Same read (rescheduling with no new data): the interval does not change.
      return backoffDelay(baseMs, maxMs, dataUpdatedAt < resetAt ? 0 : known.unchanged)
    }
    const sig = signature(data)
    const unchanged = known && known.sig === sig && known.at >= resetAt ? known.unchanged + 1 : 0
    seen.set(query.queryHash, { at: dataUpdatedAt, sig, unchanged })
    return backoffDelay(baseMs, maxMs, unchanged)
  }
}
