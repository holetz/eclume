import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { safeReturnPath } from '../../app/session'
import { fixtures } from '../../test/fixtures'
import { empty, mockFetch, problem } from '../../test/http'
import { preloadRoute, renderApp } from '../../test/render'

beforeAll(() => preloadRoute('/ajuda'))

afterEach(() => {
  vi.unstubAllGlobals()
  window.sessionStorage.clear()
})

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

  it('entrar com outra conta apaga o cache e os rascunhos da anterior; a mesma conta os reencontra', async () => {
    const draft = 'eclume-resumo-rascunho:gravacao-da-outra'
    for (const [previous, kept] of [
      ['outra-conta', false],
      [fixtures.me().user.id, true],
    ] as const) {
      window.sessionStorage.setItem('eclume-conta', previous)
      window.sessionStorage.setItem(draft, '{"base_version":1,"content_md":"# Da outra"}')
      let loggedIn = false
      mockFetch({
        'GET /api/v1/me': () => (loggedIn ? fixtures.me() : problem('unauthorized', 401)),
        'POST /api/v1/auth/login': () => {
          loggedIn = true
          return empty(204)
        },
      })
      const { client, unmount } = renderApp('/entrar?volta=/ajuda')
      client.setQueryData(['recordings', 'da-outra'], ['dado da outra conta'])
      await fillLogin()
      await screen.findByText('Mariana Couto')
      expect(window.sessionStorage.getItem('eclume-conta')).toBe(fixtures.me().user.id)
      expect(window.sessionStorage.getItem(draft) !== null).toBe(kept)
      expect(client.getQueryData(['recordings', 'da-outra']) !== undefined).toBe(kept)
      unmount()
      vi.unstubAllGlobals()
    }
  })

  it('um 401 com a sessão aberta apaga o cache de usuário e mantém os rascunhos da aba', async () => {
    const draft = 'eclume-resumo-rascunho:gravacao-1'
    window.sessionStorage.setItem(draft, '{"base_version":1,"content_md":"# Meu"}')
    let loggedIn = true
    mockFetch({ 'GET /api/v1/me': () => (loggedIn ? fixtures.me() : problem('unauthorized', 401)) })
    const { client } = renderApp('/ajuda')
    await screen.findByText('Mariana Couto')
    client.setQueryData(['recordings', 'semana'], ['dado da conta'])
    loggedIn = false
    await client.refetchQueries({ queryKey: ['me'] })
    expect(await screen.findByRole('heading', { name: 'Entrar' })).toBeInTheDocument()
    expect(client.getQueryData(['recordings', 'semana'])).toBeUndefined()
    expect(window.sessionStorage.getItem(draft)).not.toBeNull()
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

  it('orienta quem esqueceu a senha e mostra o aviso de senha redefinida', async () => {
    mockFetch({ 'GET /api/v1/me': () => problem('unauthorized', 401) })
    const { router } = renderApp('/entrar')
    expect(await screen.findByText('Esqueceu a senha? Peça um link a quem administra o servidor.')).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    await act(() => router.navigate('/entrar', { state: { notice: 'Senha redefinida. Entre com a nova.' } }))
    expect(await screen.findByRole('status')).toHaveTextContent('Senha redefinida. Entre com a nova.')
  })

  it('só aceita volta para caminho interno', () => {
    expect(safeReturnPath('/gravacoes/1')).toBe('/gravacoes/1')
    expect(safeReturnPath('//evil.example')).toBe('/')
    expect(safeReturnPath('https://evil.example')).toBe('/')
    expect(safeReturnPath(null)).toBe('/')
  })
})
