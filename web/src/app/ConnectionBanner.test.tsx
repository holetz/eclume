import { onlineManager } from '@tanstack/react-query'
import { act, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fixtures } from '../test/fixtures'
import { mockFetch, problem } from '../test/http'
import { renderApp } from '../test/render'
import { ME_KEY } from './session'

afterEach(() => {
  vi.unstubAllGlobals()
  onlineManager.setOnline(true)
})

const BANNER = /Sem conexão com o servidor/

function mockShell(me: () => unknown) {
  return mockFetch({ 'GET /api/v1/me': me })
}

describe('faixa de conexão', () => {
  it('aparece sem rede e some sozinha quando a rede volta', async () => {
    mockShell(() => fixtures.me())
    renderApp('/ajuda')
    await screen.findByRole('navigation', { name: 'Principal' })
    expect(screen.queryByText(BANNER)).not.toBeInTheDocument()

    act(() => onlineManager.setOnline(false))
    expect(screen.getByText(BANNER)).toHaveAttribute('role', 'status')
    act(() => onlineManager.setOnline(true))
    expect(screen.queryByText(BANNER)).not.toBeInTheDocument()
  })

  it('aparece quando /me falha sobre a sessão em cache e some quando volta', async () => {
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
})
