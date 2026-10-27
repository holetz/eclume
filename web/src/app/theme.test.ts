import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyThemePreference, readThemePreference, watchSystemTheme } from './theme'

type Listener = () => void

/** Fake `matchMedia`: the system theme starts at `dark` and changes through `setDark`. */
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

describe('theme', () => {
  it('"Do sistema" without matchMedia writes light', () => {
    applyThemePreference('system')
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
  })

  it('"Do sistema" resolves through matchMedia and follows the change', () => {
    const media = fakeMatchMedia(true)
    applyThemePreference('system')
    const stop = watchSystemTheme()
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')

    media.setDark(false)
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')

    stop()
    expect(media.listeners.size).toBe(0)
  })

  it('the explicit choice writes eclume-tema and does not follow the system', () => {
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
