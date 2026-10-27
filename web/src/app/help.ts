// Contextual help: each page declares its page key, and the help drawer (HelpDrawer) shows the
// help center articles that cite that key in their header ("Nesta página").
import { createContext, useContext, useEffect } from 'react'
import type { HelpPageKey } from '../features/help/pages'

export interface HelpContextValue {
  open: boolean
  pageKey: HelpPageKey | null
  /** Opens the drawer; on close, focus returns to `opener` (or to the element that was active). */
  openHelp: (opener?: HTMLElement | null) => void
  closeHelp: () => void
  setPageKey: (key: HelpPageKey | null) => void
}

export const HelpContext = createContext<HelpContextValue | null>(null)

/** The help drawer, or `null` outside a HelpProvider. */
export function useHelp(): HelpContextValue | null {
  return useContext(HelpContext)
}

/** Declares the page's help key while it is mounted. */
export function useHelpTopic(key: HelpPageKey): void {
  const setPageKey = useContext(HelpContext)?.setPageKey
  useEffect(() => {
    if (!setPageKey) return
    setPageKey(key)
    return () => setPageKey(null)
  }, [key, setPageKey])
}

/** Whether the event started in a field where `?` is text: input, textarea, select or contenteditable. */
export function isEditableTarget(event: Event): boolean {
  const target = event.target
  if (!(target instanceof HTMLElement)) return false
  return target.matches('input, textarea, select') || target.isContentEditable
}

/** The `/` shortcut (search the help), outside editable fields and without modifiers. */
export function isSearchShortcut(event: KeyboardEvent): boolean {
  return event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !isEditableTarget(event)
}
