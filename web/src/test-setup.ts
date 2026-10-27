import '@testing-library/jest-dom/vitest'
import { cleanup, configure } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

// Screens load through dynamic imports; with the whole suite in parallel, the first load
// takes over 1 s on the Windows station and the `findBy` calls timed out.
configure({ asyncUtilTimeout: 5000 })

// jsdom implements neither scrolling nor media playback.
if (typeof window !== 'undefined') {
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo
  HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve())
  HTMLMediaElement.prototype.pause = vi.fn()
}

// Without `globals: true`, Testing Library does not unmount between tests on its own. The
// conversion tests run in the node environment, with no DOM or localStorage.
afterEach(() => {
  if (typeof document === 'undefined') return
  cleanup()
  localStorage.clear()
})
