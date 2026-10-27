// After a deploy, an open tab requests chunks with an old hash: it reloads once and reaches the new
// version. If the chunk fails again right after, the error goes on to `RouteError`, with no loop.

const KEY = 'eclume-recarga-chunk'
const WINDOW_MS = 60_000

function readStamp(): number {
  try {
    return Number(window.sessionStorage.getItem(KEY)) || 0
  } catch {
    return 0
  }
}

function writeStamp(value: number): boolean {
  try {
    window.sessionStorage.setItem(KEY, String(value))
    return true
  } catch {
    return false
  }
}

/** Handles a `vite:preloadError`: reloads if there was no chunk reload in the last 60 s. */
export function handlePreloadError(event: Event, now = Date.now(), reload = () => window.location.reload()): void {
  // Without `sessionStorage` there is no way to prove it is not a loop: the error goes on to the screen.
  if (now - readStamp() <= WINDOW_MS || !writeStamp(now)) return
  event.preventDefault()
  reload()
}

export function watchChunkReload(): () => void {
  const listener = (event: Event) => handlePreloadError(event)
  window.addEventListener('vite:preloadError', listener)
  return () => window.removeEventListener('vite:preloadError', listener)
}
