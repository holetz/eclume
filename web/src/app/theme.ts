// Preferência de tema: segue o sistema por padrão; a escolha explícita fica no localStorage.
export type ThemePreference = 'system' | 'light' | 'dark'

const STORAGE_KEY = 'eclume-tema'

export function readThemePreference(): ThemePreference {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    if (value === 'light' || value === 'dark') return value
  } catch {
    // Armazenamento bloqueado: segue o sistema.
  }
  return 'system'
}

export function applyThemePreference(preference: ThemePreference): void {
  const root = document.documentElement
  if (preference === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', preference)
  try {
    if (preference === 'system') localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, preference)
  } catch {
    // Armazenamento bloqueado: a escolha vale só nesta página.
  }
}
