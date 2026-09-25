import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

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
