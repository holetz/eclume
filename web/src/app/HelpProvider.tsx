import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { HelpPageKey } from '../features/help/pages'
import { hasOpenDialog } from './dialogStack'
import { HelpContext, isEditableTarget, type HelpContextValue } from './help'
import { HelpDrawer } from './HelpDrawer'

/** Holds the help drawer: `?` outside editable fields opens it, Esc closes it and returns focus. */
export function HelpProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [pageKey, setPageKey] = useState<HelpPageKey | null>(null)
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
      // With a dialog open, Esc belongs to it and the drawer does not open beneath the modal.
      if (hasOpenDialog()) return
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

  const value = useMemo<HelpContextValue>(
    () => ({ open, pageKey, openHelp, closeHelp, setPageKey }),
    [open, pageKey, openHelp, closeHelp],
  )

  return (
    <HelpContext.Provider value={value}>
      {children}
      {open && <HelpDrawer pageKey={pageKey} onClose={closeHelp} />}
    </HelpContext.Provider>
  )
}
