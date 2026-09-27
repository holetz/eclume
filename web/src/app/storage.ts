// O localStorage pode faltar (modo privado, dados bloqueados) ou lançar: ler e gravar nunca quebram
// a tela, e a falta vira "sem valor guardado".

export const STORAGE_KEYS = {
  filtersCollapsed: 'eclume-biblioteca-filtros-recolhidos',
  lastLibrary: 'eclume-biblioteca-ultima',
} as const

export function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

/** Grava o valor; `null` apaga a chave. */
export function writeStored(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, value)
  } catch {
    // Sem armazenamento, a preferência vale só nesta visita.
  }
}
