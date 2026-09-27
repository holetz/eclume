// Preferência de tema: segue o sistema por padrão; a escolha explícita fica no localStorage. O
// Design System só tem o escuro sob `data-theme="dark"`, então "Do sistema" também grava o atributo.
export type ThemePreference = 'system' | 'light' | 'dark'

const STORAGE_KEY = 'eclume-tema'
const DARK_QUERY = '(prefers-color-scheme: dark)'

export function readThemePreference(): ThemePreference {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    if (value === 'light' || value === 'dark') return value
  } catch {
    // Armazenamento bloqueado: segue o sistema.
  }
  return 'system'
}

/** O tema do sistema; sem `matchMedia` (jsdom), claro. */
function systemTheme(): 'light' | 'dark' {
  return typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light'
}

export function applyThemePreference(preference: ThemePreference): void {
  document.documentElement.setAttribute('data-theme', preference === 'system' ? systemTheme() : preference)
  try {
    if (preference === 'system') localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, preference)
  } catch {
    // Armazenamento bloqueado: a escolha vale só nesta página.
  }
}

/** Acompanha a troca de tema do sistema enquanto a preferência for "Do sistema". Devolve o cancelamento. */
export function watchSystemTheme(): () => void {
  if (typeof window.matchMedia !== 'function') return () => {}
  const query = window.matchMedia(DARK_QUERY)
  const onChange = () => {
    if (readThemePreference() === 'system') applyThemePreference('system')
  }
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}
