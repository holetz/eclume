// localStorage may be missing (private mode, blocked data) or throw: reading and writing never break
// the screen, and the absence becomes "no stored value".

export const STORAGE_KEYS = {
  filtersCollapsed: 'eclume-biblioteca-filtros-recolhidos',
  /** Prefix: the key carries the account id (`lastLibraryKey`). */
  lastLibrary: 'eclume-biblioteca-ultima',
  libraryOpening: 'eclume-biblioteca-abertura',
  workHours: 'eclume-expediente',
  density: 'eclume-densidade',
  motion: 'eclume-movimento',
  peopleColumns: 'eclume-pessoas-colunas',
  notifyOutcomes: 'eclume-aviso-navegador',
  firstStepsDismissed: 'eclume-primeiros-passos-dispensado',
  agendaTypesSeen: 'eclume-tipos-de-agenda-visto',
} as const

export function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

/** Writes the value; `null` removes the key. */
export function writeStored(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, value)
  } catch {
    // Without storage, the preference holds only for this visit.
  }
}

/**
 * The last library stores ids of person, tag, collection and field value: it is per account, and not per
 * device like the other preferences. The old global key, from before the account, goes away on the first read.
 */
export function readLastLibrary(userId: string): string | null {
  writeStored(STORAGE_KEYS.lastLibrary, null)
  return readStored(`${STORAGE_KEYS.lastLibrary}:${userId}`)
}

export function writeLastLibrary(userId: string, value: string | null): void {
  writeStored(`${STORAGE_KEYS.lastLibrary}:${userId}`, value)
}
