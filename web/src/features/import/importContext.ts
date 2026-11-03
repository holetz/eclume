import { createContext, useContext } from 'react'
import type { ImportQueue } from './useImportQueue'

/** The shell's import queue: it survives closing the modal and navigating between screens. */
export const ImportContext = createContext<ImportQueue | null>(null)

export function useImportContext(): ImportQueue {
  const queue = useContext(ImportContext)
  if (!queue) throw new Error('useImportContext fora do ImportProvider')
  return queue
}
