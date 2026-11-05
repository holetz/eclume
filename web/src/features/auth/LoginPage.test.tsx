import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { safeReturnPath } from '../../app/session'
import { setLocale } from '../../i18n'
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
  it('reads in English when the browser language is English', async () => {
    mockFetch({
      'GET /api/v1/me': () => problem('unauthorized', 401),
      'POST /api/v1/auth/login': () => problem('unauthorized', 401),
    })
    const browser = (languages: string[]) =>
      Object.defineProperty(navigator, 'languages', { configurable: true, get: () => languages })
    browser(['en-US', 'en'])
    await act(() => setLocale('en'))
    try {
      renderApp('/entrar')
      expect(await screen.findByRole('heading', { name: 'Log in' })).toBeInTheDocument()
      expect(screen.getByRole('link', { name: 'Create an account' })).toBeInTheDocument()
      await userEvent.type(screen.getByLabelText('Email'), 'mariana.couto@example.com')
      await userEvent.type(screen.getByLabelText('Password'), 'wrong-password')
      await userEvent.click(screen.getByRole('button', { name: 'Log in' }))
      expect(await screen.findByRole('alert')).toHaveTextContent('Wrong email or password.')
    } finally {
      browser(['pt-BR'])
      await act(() => setLocale('pt-BR'))
    }
  })

  it('a protected route without a session leads to the login and returns to it afterwards', async () => {
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

  it('signing in with another account clears the previous one cache and drafts; the same account finds them again', async () => {
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

  it('a 401 with the session open clears the user cache and keeps the tab drafts', async () => {
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

  it('a wrong credential shows the error without leaving the page', async () => {
    mockFetch({
      'GET /api/v1/me': () => problem('unauthorized', 401),
      'POST /api/v1/auth/login': () => problem('unauthorized', 401),
    })
    renderApp('/entrar')
    await fillLogin('errada')
    expect(await screen.findByRole('alert')).toHaveTextContent('E-mail ou senha incorretos.')
    expect(screen.getByRole('heading', { name: 'Entrar' })).toBeInTheDocument()
  })

  it('signing out ends the session and returns to the login', async () => {
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

  it('shows the brand and leads to Criar conta', async () => {
    mockFetch({ 'GET /api/v1/me': () => problem('unauthorized', 401) })
    renderApp('/entrar')
    expect(await screen.findByRole('heading', { level: 2, name: 'Entrar' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Cada palavra, guardada no seu servidor.' })).toBeInTheDocument()
    expect(screen.getByRole('main')).toHaveClass('auth')
    expect(screen.getByRole('link', { name: 'Criar conta' })).toHaveAttribute('href', '/cadastro')
  })

  it('guides whoever forgot the password and shows the password-reset notice', async () => {
    mockFetch({ 'GET /api/v1/me': () => problem('unauthorized', 401) })
    const { router } = renderApp('/entrar')
    expect(await screen.findByText('Esqueceu a senha? Peça um link a quem administra o servidor.')).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    await act(() => router.navigate('/entrar', { state: { notice: 'Senha redefinida. Entre com a nova.' } }))
    expect(await screen.findByRole('status')).toHaveTextContent('Senha redefinida. Entre com a nova.')
  })

  it('only accepts returning to an internal path', () => {
    expect(safeReturnPath('/gravacoes/1')).toBe('/gravacoes/1')
    expect(safeReturnPath('//evil.example')).toBe('/')
    expect(safeReturnPath('https://evil.example')).toBe('/')
    expect(safeReturnPath(null)).toBe('/')
  })
})
