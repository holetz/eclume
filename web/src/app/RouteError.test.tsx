import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fixtures } from '../test/fixtures'
import { mockFetch } from '../test/http'
import { preloadRoute, renderApp } from '../test/render'

beforeAll(() => preloadRoute('/busca'))

// The search simulates the chunk that did not load after a deploy; the login, an ordinary exception outside the shell.
vi.mock('../features/search/SearchPage', () => ({
  SearchPage: () => {
    throw new TypeError('Failed to fetch dynamically imported module: /assets/SearchPage-velho.js')
  },
}))
vi.mock('../features/auth/LoginPage', () => ({
  LoginPage: () => {
    throw new Error('broke')
  },
}))
vi.mock('../features/library/LibraryPage', () => ({
  LibraryPage: () => <h1>Biblioteca de teste</h1>,
}))

beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}))
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('per-route error', () => {
  it('shows the failed chunk inside the shell, and the sidebar leaves the error', async () => {
    mockFetch({ 'GET /api/v1/me': () => fixtures.me() })
    renderApp('/busca')
    const main = await screen.findByRole('main')
    expect(await within(main).findByRole('heading', { level: 1, name: 'O eclume foi atualizado' })).toBeInTheDocument()
    expect(within(main).getByRole('button', { name: 'Recarregar' })).toBeInTheDocument()

    const nav = screen.getByRole('navigation', { name: 'Principal' })
    await userEvent.click(within(nav).getByRole('link', { name: 'Biblioteca' }))
    expect(await screen.findByRole('heading', { name: 'Biblioteca de teste' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'O eclume foi atualizado' })).not.toBeInTheDocument()
  })

  it('outside the shell, the error takes the whole page', async () => {
    mockFetch({})
    renderApp('/entrar')
    expect(await screen.findByRole('heading', { level: 1, name: 'Algo deu errado nesta tela' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Recarregar' })).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Principal' })).not.toBeInTheDocument()
  })
})
