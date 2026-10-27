// Theme preference: follows the system by default; the explicit choice stays in localStorage. The
// Design System only has dark under `data-theme="dark"`, so "Do sistema" also writes the attribute.
export type ThemePreference = 'system' | 'light' | 'dark'

const STORAGE_KEY = 'eclume-tema'
const DARK_QUERY = '(prefers-color-scheme: dark)'

export function readThemePreference(): ThemePreference {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    if (value === 'light' || value === 'dark') return value
  } catch {
    // Storage blocked: follow the system.
  }
  return 'system'
}

/** The system theme; without `matchMedia` (jsdom), light. */
function systemTheme(): 'light' | 'dark' {
  return typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light'
}

export function applyThemePreference(preference: ThemePreference): void {
  document.documentElement.setAttribute('data-theme', preference === 'system' ? systemTheme() : preference)
  try {
    if (preference === 'system') localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, preference)
  } catch {
    // Storage blocked: the choice holds only on this page.
  }
}

/** Follows the system theme change while the preference is "Do sistema". Returns the cancellation. */
export function watchSystemTheme(): () => void {
  if (typeof window.matchMedia !== 'function') return () => {}
  const query = window.matchMedia(DARK_QUERY)
  const onChange = () => {
    if (readThemePreference() === 'system') applyThemePreference('system')
  }
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}
