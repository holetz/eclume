import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { HELP_TOPICS, HelpContext, isEditableTarget, type HelpContextValue } from './help'
import { HelpDrawer } from './HelpDrawer'

/** Guarda a gaveta de ajuda: `?` fora de campos editáveis abre, Esc fecha e devolve o foco. */
export function HelpProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [topicKey, setTopicKey] = useState<string | null>(null)
  const opener = useRef<HTMLElement | null>(null)

  const openHelp = useCallback((from?: HTMLElement | null) => {
    opener.current = from ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    setOpen(true)
  }, [])

  const closeHelp = useCallback(() => {
    setOpen(false)
    opener.current?.focus()
    opener.current = null
  }, [])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && open) {
        closeHelp()
      } else if (event.key === '?' && !event.ctrlKey && !event.metaKey && !event.altKey && !isEditableTarget(event)) {
        event.preventDefault()
        if (!open) openHelp()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, openHelp, closeHelp])

  const topic = topicKey ? (HELP_TOPICS[topicKey] ?? null) : null
  const value = useMemo<HelpContextValue>(
    () => ({ open, topic, openHelp, closeHelp, setTopicKey }),
    [open, topic, openHelp, closeHelp],
  )

  return (
    <HelpContext.Provider value={value}>
      {children}
      {open && <HelpDrawer topic={topic} onClose={closeHelp} />}
    </HelpContext.Provider>
  )
}
