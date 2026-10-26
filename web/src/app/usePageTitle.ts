import { useEffect } from 'react'

// The tab title is the page's, prefixed with how many processing outcomes arrived with the tab
// in the background ("(2) Biblioteca · eclume"); the outcome watcher (processingWatch) resets it on return.
let base = 'eclume'
let count = 0

function render(): void {
  document.title = count > 0 ? `(${count}) ${base}` : base
}

/** The counter in front of the title; 0 removes it. */
export function setTitleCount(value: number): void {
  count = value
  render()
}

export function usePageTitle(title: string): void {
  useEffect(() => {
    base = title ? `${title} · eclume` : 'eclume'
    render()
  }, [title])
}
