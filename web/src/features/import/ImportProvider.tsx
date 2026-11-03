import { useEffect, type ReactNode } from 'react'
import { ImportContext } from './importContext'
import { useImportQueue } from './useImportQueue'

/**
 * Mounts the import queue in the shell. While a file converts or uploads, leaving the page asks the
 * browser for confirmation.
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
