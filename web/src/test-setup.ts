import '@testing-library/jest-dom/vitest'
import { cleanup, configure } from '@testing-library/react'
import { afterEach, vi } from 'vitest'
import { i18n, startI18n } from './i18n'

// Unit tests run in pt-BR so the existing pt-BR assertions hold; a test that needs en switches explicitly.
// The browser language is pt-BR too, so `LocaleSync` keeps pt-BR for a session with no account locale.
if (typeof navigator !== 'undefined') {
  Object.defineProperty(navigator, 'languages', { configurable: true, get: () => ['pt-BR'] })
  Object.defineProperty(navigator, 'language', { configurable: true, get: () => 'pt-BR' })
}
// Only pt-BR up front, as in production: a test that needs en loads it through `setLocale`.
await startI18n('pt-BR')

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
  void i18n.changeLanguage('pt-BR')
  if (typeof document === 'undefined') return
  document.documentElement.lang = 'pt-BR'
  cleanup()
  localStorage.clear()
})
