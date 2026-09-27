import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { safeReturnPath } from '../../app/session'
import { fixtures } from '../../test/fixtures'
import { empty, mockFetch, problem } from '../../test/http'
import { renderApp } from '../../test/render'

afterEach(() => vi.unstubAllGlobals())

async function fillLogin(password = 'segredo-forte') {
  await userEvent.type(await screen.findByLabelText('E-mail'), 'mariana.couto@example.com')
  await userEvent.type(screen.getByLabelText('Senha'), password)
  await userEvent.click(screen.getByRole('button', { name: 'Entrar' }))
}

describe('login', () => {
  it('rota protegida sem sessão leva ao login e volta para ela depois', async () => {
    let loggedIn = false
    const http = mockFetch({
      'GET /api/v1/me': () => (loggedIn ? fixtures.me() : problem('unauthorized', 401)),
      'POST /api/v1/auth/login': () => {
        loggedIn = true
        return empty(204)
      },
    })
    renderApp('/rota-antiga?x=1')
    await fillLogin()
    expect(await screen.findByRole('heading', { name: 'Página não encontrada' })).toBeInTheDocument()
    expect(screen.getByText('Mariana Couto')).toBeInTheDocument()
    const body = await http.requests('POST /api/v1/auth/login')[0].json()
    expect(body).toEqual({ email: 'mariana.couto@example.com', password: 'segredo-forte' })
  })

  it('credencial errada mostra o erro sem sair da página', async () => {
    mockFetch({
      'GET /api/v1/me': () => problem('unauthorized', 401),
      'POST /api/v1/auth/login': () => problem('unauthorized', 401),
    })
    renderApp('/entrar')
    await fillLogin('errada')
    expect(await screen.findByRole('alert')).toHaveTextContent('E-mail ou senha incorretos.')
    expect(screen.getByRole('heading', { name: 'Entrar' })).toBeInTheDocument()
  })

  it('sair encerra a sessão e volta ao login', async () => {
    let loggedIn = true
    const http = mockFetch({
      'GET /api/v1/me': () => (loggedIn ? fixtures.me() : problem('unauthorized', 401)),
      'POST /api/v1/auth/logout': () => {
        loggedIn = false
        return empty(204)
      },
    })
    renderApp('/')
    await userEvent.click(await screen.findByRole('button', { name: 'Sair' }))
    expect(await screen.findByRole('heading', { name: 'Entrar' })).toBeInTheDocument()
    await waitFor(() => expect(http.requests('POST /api/v1/auth/logout')).toHaveLength(1))
  })

  it('mostra a marca e leva a Criar conta', async () => {
    mockFetch({ 'GET /api/v1/me': () => problem('unauthorized', 401) })
    renderApp('/entrar')
    expect(await screen.findByRole('heading', { level: 2, name: 'Entrar' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Cada palavra, guardada em casa.' })).toBeInTheDocument()
    expect(screen.getByRole('main')).toHaveClass('auth')
    expect(screen.getByRole('link', { name: 'Criar conta' })).toHaveAttribute('href', '/cadastro')
  })

  it('só aceita volta para caminho interno', () => {
    expect(safeReturnPath('/gravacoes/1')).toBe('/gravacoes/1')
    expect(safeReturnPath('//evil.example')).toBe('/')
    expect(safeReturnPath('https://evil.example')).toBe('/')
    expect(safeReturnPath(null)).toBe('/')
  })
})
