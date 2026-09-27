import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fixtures } from '../../test/fixtures'
import { empty, mockFetch, problem } from '../../test/http'
import { renderApp } from '../../test/render'

afterEach(() => vi.unstubAllGlobals())

function mockAdminApi(extra: Parameters<typeof mockFetch>[0] = {}) {
  return mockFetch({
    'GET /api/v1/admin/me': () => fixtures.adminMe(),
    'GET /api/v1/admin/settings': () => fixtures.adminSettings(),
    'GET /api/v1/admin/agent-providers': () => fixtures.agentProviderPage(),
    'GET /api/v1/admin/secrets': () => fixtures.secretList(),
    'GET /api/v1/admin/users': () => fixtures.adminUserPage(),
    'GET /api/v1/admin/health': () => fixtures.adminHealth(),
    ...extra,
  })
}

const signedOut = () => problem('unauthorized', 401)

async function signIn(email = 'mariana.couto@example.com', password = 'senha-do-admin') {
  await userEvent.type(await screen.findByLabelText('E-mail'), email)
  await userEvent.type(screen.getByLabelText('Senha'), password)
  await userEvent.click(screen.getByRole('button', { name: 'Entrar' }))
}

describe('login do admin', () => {
  it('tem a variante do painel, sem cadastro nem sessão de usuário', async () => {
    const http = mockAdminApi({ 'GET /api/v1/admin/me': signedOut })
    const { container } = renderApp('/admin/entrar')
    expect(await screen.findByRole('heading', { name: 'Entrar como admin' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Painel de administração' })).toBeInTheDocument()
    expect(screen.getByText('Separado das contas de usuário. Só configurações da plataforma.')).toBeInTheDocument()
    expect(container.querySelector('main.auth.auth-admin')).not.toBeNull()
    expect(screen.queryByRole('link', { name: /Criar conta/ })).not.toBeInTheDocument()
    expect(document.title).toBe('Entrar — Admin eclume')
    expect(http.requests('GET /api/v1/me')).toHaveLength(0)
  })

  it('sem sessão de admin, a guarda leva ao login com a volta', async () => {
    const http = mockAdminApi({ 'GET /api/v1/admin/me': signedOut })
    renderApp('/admin/saude?x=1')
    expect(await screen.findByRole('heading', { name: 'Entrar como admin' })).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Principal' })).not.toBeInTheDocument()
    // O painel nunca lê a sessão do usuário.
    expect(http.requests('GET /api/v1/me')).toHaveLength(0)
  })

  it('o login abre a sessão de admin e volta à rota pedida', async () => {
    let session = false
    const http = mockAdminApi({
      'GET /api/v1/admin/me': () => (session ? fixtures.adminMe() : signedOut()),
      'POST /api/v1/admin/auth/login': () => {
        session = true
        return empty()
      },
    })
    renderApp('/admin/usuarios')
    await signIn()
    expect(await screen.findByRole('heading', { name: 'Usuários' })).toBeInTheDocument()
    expect(await http.requests('POST /api/v1/admin/auth/login')[0].json()).toEqual({
      email: 'mariana.couto@example.com',
      password: 'senha-do-admin',
    })
    expect(http.requests('GET /api/v1/me')).toHaveLength(0)
  })

  it('volta fora do painel cai em Usuários', async () => {
    let session = false
    mockAdminApi({
      'GET /api/v1/admin/me': () => (session ? fixtures.adminMe() : signedOut()),
      'POST /api/v1/admin/auth/login': () => {
        session = true
        return empty()
      },
    })
    renderApp('/admin/entrar?volta=%2Fgravacoes%2F1')
    await signIn()
    expect(await screen.findByRole('heading', { name: 'Usuários' })).toBeInTheDocument()
  })

  it('senha errada', async () => {
    mockAdminApi({ 'GET /api/v1/admin/me': signedOut, 'POST /api/v1/admin/auth/login': signedOut })
    renderApp('/admin/entrar')
    await signIn('x@y.com.br', 'errada')
    expect(await screen.findByRole('alert')).toHaveTextContent('E-mail ou senha incorretos.')
  })

  it('com a sessão de admin aberta, o login leva ao painel', async () => {
    mockAdminApi()
    renderApp('/admin/entrar')
    expect(await screen.findByRole('heading', { name: 'Usuários' })).toBeInTheDocument()
  })
})

describe('sessão de admin', () => {
  it('um 401 durante o uso leva ao login com a volta', async () => {
    let session = true
    mockAdminApi({
      'GET /api/v1/admin/me': () => (session ? fixtures.adminMe() : signedOut()),
      'GET /api/v1/admin/users': () => {
        session = false
        return signedOut()
      },
    })
    renderApp('/admin/usuarios')
    expect(await screen.findByRole('heading', { name: 'Entrar como admin' })).toBeInTheDocument()
  })

  it('sair encerra a sessão de admin', async () => {
    const http = mockAdminApi({ 'POST /api/v1/admin/auth/logout': () => empty() })
    renderApp('/admin/usuarios')
    await userEvent.click(await screen.findByRole('button', { name: 'Sair' }))
    expect(await screen.findByRole('heading', { name: 'Entrar como admin' })).toBeInTheDocument()
    await waitFor(() => expect(http.requests('POST /api/v1/admin/auth/logout')).toHaveLength(1))
  })
})
