import { useEffect } from 'react'

// O título da aba é o da página com, na frente, quantos desfechos de processamento chegaram com a aba
// em segundo plano ("(2) Biblioteca · eclume"); o observador de desfechos (processingWatch) zera ao voltar.
let base = 'eclume'
let count = 0

function render(): void {
  document.title = count > 0 ? `(${count}) ${base}` : base
}

/** O contador na frente do título; 0 o tira. */
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
