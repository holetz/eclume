// O localStorage pode faltar (modo privado, dados bloqueados) ou lançar: ler e gravar nunca quebram
// a tela, e a falta vira "sem valor guardado".

export const STORAGE_KEYS = {
  filtersCollapsed: 'eclume-biblioteca-filtros-recolhidos',
  /** Prefixo: a chave leva o id da conta (`lastLibraryKey`). */
  lastLibrary: 'eclume-biblioteca-ultima',
  libraryOpening: 'eclume-biblioteca-abertura',
  workHours: 'eclume-expediente',
  density: 'eclume-densidade',
  motion: 'eclume-movimento',
  peopleColumns: 'eclume-pessoas-colunas',
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

/**
 * A última biblioteca guarda ids de pessoa, tag, coleção e valor de campo: é por conta, e não por
 * aparelho como as outras preferências. A chave global antiga, de antes da conta, sai na primeira leitura.
 */
export function readLastLibrary(userId: string): string | null {
  writeStored(STORAGE_KEYS.lastLibrary, null)
  return readStored(`${STORAGE_KEYS.lastLibrary}:${userId}`)
}

export function writeLastLibrary(userId: string, value: string | null): void {
  writeStored(`${STORAGE_KEYS.lastLibrary}:${userId}`, value)
}
