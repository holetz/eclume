// The theme follows the system: `data-theme` on the root, which the DS uses for the dark colors. The
// WebView with targetSdk 33+ delivers Android's `prefers-color-scheme`.

const QUERY = '(prefers-color-scheme: dark)'

export function applyTheme(dark: boolean) {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
}

/** Applies the system theme and follows its changes; returns the function that stops. */
export function followSystemTheme(): () => void {
  const media = window.matchMedia?.(QUERY)
  if (!media) {
    applyTheme(false)
    return () => {}
  }
  applyTheme(media.matches)
  const onChange = (event: MediaQueryListEvent) => applyTheme(event.matches)
  media.addEventListener('change', onChange)
  return () => media.removeEventListener('change', onChange)
}

/** The edge-to-edge insets (Android 15+) become --safe-top and --safe-bottom. */
export function applyInsets(insets: { top: number; bottom: number }) {
  const root = document.documentElement.style
  root.setProperty('--safe-top', `${insets.top}px`)
  root.setProperty('--safe-bottom', `${insets.bottom}px`)
}
