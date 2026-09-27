import { createContext, useContext } from 'react'
import type { ImportQueue } from './useImportQueue'

/** A fila de importação do shell: sobrevive a fechar o modal e a navegar entre as telas. */
export const ImportContext = createContext<ImportQueue | null>(null)

export function useImportContext(): ImportQueue {
  const queue = useContext(ImportContext)
  if (!queue) throw new Error('useImportContext fora do ImportProvider')
  return queue
}
