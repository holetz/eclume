import { afterEach, describe, expect, it, vi } from 'vitest'
import { handlePreloadError } from './chunkReload'

afterEach(() => window.sessionStorage.clear())

function preloadError() {
  return new Event('vite:preloadError', { cancelable: true })
}

describe('chunk reload', () => {
  it('reloads once and lets the second error go on to the screen', () => {
    const reload = vi.fn()
    const first = preloadError()
    handlePreloadError(first, 1_000_000, reload)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(first.defaultPrevented).toBe(true)

    const second = preloadError()
    handlePreloadError(second, 1_030_000, reload)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(second.defaultPrevented).toBe(false)
  })

  it('reloads again after the 60 s window, for a second deploy in the same tab', () => {
    const reload = vi.fn()
    handlePreloadError(preloadError(), 1_000_000, reload)
    handlePreloadError(preloadError(), 1_061_000, reload)
    expect(reload).toHaveBeenCalledTimes(2)
  })
})
