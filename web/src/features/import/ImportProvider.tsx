import { useEffect, type ReactNode } from 'react'
import { ImportContext } from './importContext'
import { useImportQueue } from './useImportQueue'

/**
 * Monta a fila de importação no shell. Enquanto um arquivo converte ou sobe, sair da página pede
 * confirmação ao navegador.
 */
export function ImportProvider({ children }: { children: ReactNode }) {
  const queue = useImportQueue()
  const { sending } = queue

  useEffect(() => {
    if (!sending) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [sending])

  return <ImportContext.Provider value={queue}>{children}</ImportContext.Provider>
}
