import '@testing-library/jest-dom/vitest'
import { cleanup, configure } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

// As telas carregam por import dinâmico; com a suíte inteira em paralelo, o primeiro carregamento
// passa de 1 s na estação Windows e os `findBy` falhavam por tempo.
configure({ asyncUtilTimeout: 5000 })

// O jsdom não implementa rolagem nem reprodução de mídia.
if (typeof window !== 'undefined') {
  Element.prototype.scrollIntoView = vi.fn()
  HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve())
  HTMLMediaElement.prototype.pause = vi.fn()
}

// Sem `globals: true`, o Testing Library não desmonta sozinho entre os testes. Os testes da
// conversão rodam no ambiente node, sem DOM nem localStorage.
afterEach(() => {
  if (typeof document === 'undefined') return
  cleanup()
  localStorage.clear()
})
