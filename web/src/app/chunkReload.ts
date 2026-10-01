// Depois de um deploy, a aba aberta pede chunks de hash antigo: recarrega uma vez e chega na versão
// nova. Se o chunk falhar de novo logo em seguida, o erro segue para o `RouteError`, sem laço.

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

/** Trata um `vite:preloadError`: recarrega se não houve recarga por chunk nos últimos 60 s. */
export function handlePreloadError(event: Event, now = Date.now(), reload = () => window.location.reload()): void {
  // Sem `sessionStorage` não há como provar que não é laço: o erro segue para a tela.
  if (now - readStamp() <= WINDOW_MS || !writeStamp(now)) return
  event.preventDefault()
  reload()
}

export function watchChunkReload(): () => void {
  const listener = (event: Event) => handlePreloadError(event)
  window.addEventListener('vite:preloadError', listener)
  return () => window.removeEventListener('vite:preloadError', listener)
}
