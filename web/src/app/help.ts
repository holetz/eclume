// Ajuda contextual: cada página declara o seu tópico, e a gaveta de ajuda (HelpDrawer) mostra os
// links dele. O conteúdo dos tópicos chega com holetz/eclume#38.
import { createContext, useContext, useEffect } from 'react'

export interface HelpTopic {
  title: string
  links: { label: string; to: string }[]
}

export const HELP_TOPICS: Record<string, HelpTopic> = {}

export interface HelpContextValue {
  open: boolean
  topic: HelpTopic | null
  /** Abre a gaveta; ao fechar, o foco volta para `opener` (ou para o elemento que estava ativo). */
  openHelp: (opener?: HTMLElement | null) => void
  closeHelp: () => void
  setTopicKey: (key: string | null) => void
}

export const HelpContext = createContext<HelpContextValue | null>(null)

/** A gaveta de ajuda, ou `null` fora de um HelpProvider. */
export function useHelp(): HelpContextValue | null {
  return useContext(HelpContext)
}

/** Declara o tópico de ajuda da página enquanto ela está montada. */
export function useHelpTopic(key: string): void {
  const setTopicKey = useContext(HelpContext)?.setTopicKey
  useEffect(() => {
    if (!setTopicKey) return
    setTopicKey(key)
    return () => setTopicKey(null)
  }, [key, setTopicKey])
}

/** Se o evento nasceu num campo em que `?` é texto: input, textarea, select ou contenteditable. */
export function isEditableTarget(event: Event): boolean {
  const target = event.target
  if (!(target instanceof HTMLElement)) return false
  return target.matches('input, textarea, select') || target.isContentEditable
}
