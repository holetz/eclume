import { afterEach, describe, expect, it, vi } from 'vitest'
import { handlePreloadError } from './chunkReload'

afterEach(() => window.sessionStorage.clear())

function preloadError() {
  return new Event('vite:preloadError', { cancelable: true })
}

describe('recarga por chunk', () => {
  it('recarrega uma vez e deixa o segundo erro seguir para a tela', () => {
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

  it('volta a recarregar depois da janela de 60 s, para um segundo deploy na mesma aba', () => {
    const reload = vi.fn()
    handlePreloadError(preloadError(), 1_000_000, reload)
    handlePreloadError(preloadError(), 1_061_000, reload)
    expect(reload).toHaveBeenCalledTimes(2)
  })
})
