// O tema segue o sistema: `data-theme` na raiz, que o DS usa para as cores escuras. O WebView com
// targetSdk 33+ entrega o `prefers-color-scheme` do Android.

const CONSULTA = '(prefers-color-scheme: dark)'

export function aplicarTema(escuro: boolean) {
  document.documentElement.dataset.theme = escuro ? 'dark' : 'light'
}

/** Aplica o tema do sistema e acompanha as mudanças; devolve a função que para. */
export function seguirTemaDoSistema(): () => void {
  const midia = window.matchMedia?.(CONSULTA)
  if (!midia) {
    aplicarTema(false)
    return () => {}
  }
  aplicarTema(midia.matches)
  const aoMudar = (evento: MediaQueryListEvent) => aplicarTema(evento.matches)
  midia.addEventListener('change', aoMudar)
  return () => midia.removeEventListener('change', aoMudar)
}

/** Os recortes de borda a borda (Android 15+) viram --safe-top e --safe-bottom. */
export function aplicarRecortes(recortes: { topo: number; base: number }) {
  const raiz = document.documentElement.style
  raiz.setProperty('--safe-top', `${recortes.topo}px`)
  raiz.setProperty('--safe-bottom', `${recortes.base}px`)
}
