import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fixtures } from '../test/fixtures'
import { mockFetch } from '../test/http'
import { renderApp } from '../test/render'

// A busca simula o chunk que não carregou depois de um deploy; o login, uma exceção comum fora do shell.
vi.mock('../features/search/SearchPage', () => ({
  SearchPage: () => {
    throw new TypeError('Failed to fetch dynamically imported module: /assets/SearchPage-velho.js')
  },
}))
vi.mock('../features/auth/LoginPage', () => ({
  LoginPage: () => {
    throw new Error('quebrou')
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

describe('erro por rota', () => {
  it('mostra o chunk que falhou dentro do shell, e a barra sai do erro', async () => {
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

  it('fora do shell, o erro ocupa a página inteira', async () => {
    mockFetch({})
    renderApp('/entrar')
    expect(await screen.findByRole('heading', { level: 1, name: 'Algo deu errado nesta tela' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Recarregar' })).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Principal' })).not.toBeInTheDocument()
  })
})
