import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyThemePreference, readThemePreference, watchSystemTheme } from './theme'

type Listener = () => void

/** `matchMedia` falso: o tema do sistema começa em `dark` e muda por `setDark`. */
function fakeMatchMedia(dark: boolean) {
  const listeners = new Set<Listener>()
  const query = {
    get matches() {
      return dark
    },
    addEventListener: (_: string, listener: Listener) => listeners.add(listener),
    removeEventListener: (_: string, listener: Listener) => listeners.delete(listener),
  }
  vi.stubGlobal('matchMedia', () => query)
  return {
    listeners,
    setDark(value: boolean) {
      dark = value
      listeners.forEach((listener) => listener())
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.documentElement.removeAttribute('data-theme')
})

describe('tema', () => {
  it('"Do sistema" sem matchMedia grava o claro', () => {
    applyThemePreference('system')
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
  })

  it('"Do sistema" resolve pelo matchMedia e acompanha a mudança', () => {
    const media = fakeMatchMedia(true)
    applyThemePreference('system')
    const stop = watchSystemTheme()
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')

    media.setDark(false)
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')

    stop()
    expect(media.listeners.size).toBe(0)
  })

  it('a escolha explícita grava eclume-tema e não segue o sistema', () => {
    const media = fakeMatchMedia(false)
    const stop = watchSystemTheme()
    applyThemePreference('dark')
    expect(localStorage.getItem('eclume-tema')).toBe('dark')
    expect(readThemePreference()).toBe('dark')

    media.setDark(false)
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    stop()

    applyThemePreference('system')
    expect(localStorage.getItem('eclume-tema')).toBeNull()
  })
})
