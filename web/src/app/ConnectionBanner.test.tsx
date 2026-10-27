import { onlineManager } from '@tanstack/react-query'
import { act, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { fixtures } from '../test/fixtures'
import { mockFetch, problem } from '../test/http'
import { preloadRoute, renderApp } from '../test/render'
import { ME_KEY } from './session'

beforeAll(() => preloadRoute('/ajuda'))

afterEach(() => {
  vi.unstubAllGlobals()
  onlineManager.setOnline(true)
})

const BANNER = /Sem conexão com o servidor/

function mockShell(me: () => unknown) {
  return mockFetch({ 'GET /api/v1/me': me })
}

describe('connection banner', () => {
  it('appears without network and goes away on its own when the network returns', async () => {
    mockShell(() => fixtures.me())
    renderApp('/ajuda')
    await screen.findByRole('navigation', { name: 'Principal' })
    expect(screen.queryByText(BANNER)).not.toBeInTheDocument()

    act(() => onlineManager.setOnline(false))
    expect(screen.getByText(BANNER)).toHaveAttribute('role', 'status')
    act(() => onlineManager.setOnline(true))
    expect(screen.queryByText(BANNER)).not.toBeInTheDocument()
  })

  it('appears when /me fails over the cached session and goes away when it returns', async () => {
    let down = false
    mockShell(() => (down ? problem('unavailable', 503) : fixtures.me()))
    const { client } = renderApp('/ajuda')
    await screen.findByRole('navigation', { name: 'Principal' })

    down = true
    await act(() => client.refetchQueries({ queryKey: ME_KEY }))
    expect(await screen.findByText(BANNER)).toBeInTheDocument()
    down = false
    await act(() => client.refetchQueries({ queryKey: ME_KEY }))
    await waitFor(() => expect(screen.queryByText(BANNER)).not.toBeInTheDocument())
  })

  it('with the server down, retries every 10 s and doubles up to 60 s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      let down = false
      const http = mockShell(() => (down ? problem('unavailable', 503) : fixtures.me()))
      const { client } = renderApp('/ajuda')
      await screen.findByRole('navigation', { name: 'Principal' })

      down = true
      await act(() => client.refetchQueries({ queryKey: ME_KEY }))
      expect(await screen.findByText(BANNER)).toBeInTheDocument()
      const reads = () => http.requests('GET /api/v1/me').length
      const base = reads()
      const after = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms))
      await after(9_000)
      expect(reads()).toBe(base)
      await after(1_000)
      expect(reads()).toBe(base + 1)
      await after(19_000)
      expect(reads()).toBe(base + 1)
      await after(1_000)
      expect(reads()).toBe(base + 2)
      await after(40_000)
      expect(reads()).toBe(base + 3)
      await after(60_000)
      expect(reads()).toBe(base + 4)
      await after(60_000)
      expect(reads()).toBe(base + 5)
    } finally {
      vi.useRealTimers()
    }
  })
})
