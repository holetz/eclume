// Ajuda contextual: cada página declara a sua chave de página, e a gaveta de ajuda (HelpDrawer)
// mostra os artigos da central que citam essa chave no cabeçalho ("Nesta página").
import { createContext, useContext, useEffect } from 'react'
import type { HelpPageKey } from '../features/help/pages'

export interface HelpContextValue {
  open: boolean
  pageKey: HelpPageKey | null
  /** Abre a gaveta; ao fechar, o foco volta para `opener` (ou para o elemento que estava ativo). */
  openHelp: (opener?: HTMLElement | null) => void
  closeHelp: () => void
  setPageKey: (key: HelpPageKey | null) => void
}

export const HelpContext = createContext<HelpContextValue | null>(null)

/** A gaveta de ajuda, ou `null` fora de um HelpProvider. */
export function useHelp(): HelpContextValue | null {
  return useContext(HelpContext)
}

/** Declara a chave de ajuda da página enquanto ela está montada. */
export function useHelpTopic(key: HelpPageKey): void {
  const setPageKey = useContext(HelpContext)?.setPageKey
  useEffect(() => {
    if (!setPageKey) return
    setPageKey(key)
    return () => setPageKey(null)
  }, [key, setPageKey])
}

/** Se o evento nasceu num campo em que `?` é texto: input, textarea, select ou contenteditable. */
export function isEditableTarget(event: Event): boolean {
  const target = event.target
  if (!(target instanceof HTMLElement)) return false
  return target.matches('input, textarea, select') || target.isContentEditable
}

/** O atalho `/` (buscar na ajuda), fora de campos editáveis e sem modificadores. */
export function isSearchShortcut(event: KeyboardEvent): boolean {
  return event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !isEditableTarget(event)
}
