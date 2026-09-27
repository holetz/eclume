import '@testing-library/jest-dom/vitest'
import { cleanup, configure } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

// O jsdom não implementa rolagem nem reprodução de mídia.
if (typeof window !== 'undefined') {
  Element.prototype.scrollIntoView = vi.fn()
  HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve())
  HTMLMediaElement.prototype.pause = vi.fn()
  // Nem o modal do <dialog>: basta o atributo `open`.
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true
  }
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false
  }
}

// A suíte inteira roda em paralelo, e numa máquina carregada o primeiro render de uma rota lazy
// passa de 1 s: o findBy espera até 3 s antes de falhar.
configure({ asyncUtilTimeout: 3000 })

// Sem `globals: true`, o Testing Library não desmonta sozinho entre os testes. Os testes da
// conversão rodam no ambiente node, sem DOM nem localStorage.
afterEach(() => {
  if (typeof document === 'undefined') return
  cleanup()
  localStorage.clear()
})
