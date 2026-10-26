import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { fixtures } from '../../test/fixtures'
import { empty, mockFetch, problem } from '../../test/http'
import { preloadRoute, renderApp } from '../../test/render'

beforeAll(() => preloadRoute('/admin/entrar', '/admin/saude', '/admin/usuarios', '/admin', '/admin/nao-existe'))

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

describe('admin login', () => {
  it('has the panel variant, with no signup nor user session', async () => {
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

  it('without an admin session, the guard leads to the login with the return path', async () => {
    const http = mockAdminApi({ 'GET /api/v1/admin/me': signedOut })
    renderApp('/admin/saude?x=1')
    expect(await screen.findByRole('heading', { name: 'Entrar como admin' })).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Principal' })).not.toBeInTheDocument()
    // The panel never reads the user session.
    expect(http.requests('GET /api/v1/me')).toHaveLength(0)
  })

  it('the login opens the admin session and returns to the requested route', async () => {
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

  it('a return path outside the panel lands on Usuários', async () => {
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

  it('wrong password', async () => {
    mockAdminApi({ 'GET /api/v1/admin/me': signedOut, 'POST /api/v1/admin/auth/login': signedOut })
    renderApp('/admin/entrar')
    await signIn('x@y.com.br', 'errada')
    expect(await screen.findByRole('alert')).toHaveTextContent('E-mail ou senha incorretos.')
  })

  it('with the admin session open, the login leads to the panel', async () => {
    mockAdminApi()
    renderApp('/admin/entrar')
    expect(await screen.findByRole('heading', { name: 'Usuários' })).toBeInTheDocument()
  })
})

describe('admin session', () => {
  it('a 401 during use leads to the login with the return path', async () => {
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

  it('signing out ends the admin session', async () => {
    const http = mockAdminApi({ 'POST /api/v1/admin/auth/logout': () => empty() })
    renderApp('/admin/usuarios')
    await userEvent.click(await screen.findByRole('button', { name: 'Sair' }))
    expect(await screen.findByRole('heading', { name: 'Entrar como admin' })).toBeInTheDocument()
    await waitFor(() => expect(http.requests('POST /api/v1/admin/auth/logout')).toHaveLength(1))
  })
})

describe('panel frame', () => {
  it('has the brand with the Admin badge, the seven Plataforma sections and the account in the footer', async () => {
    const http = mockAdminApi()
    renderApp('/admin')
    expect(await screen.findByRole('heading', { name: 'Usuários' })).toBeInTheDocument()
    expect(screen.getAllByText('Admin', { selector: '.tag.tag-outline' }).length).toBeGreaterThan(0)
    const nav = screen.getByRole('navigation', { name: 'Plataforma' })
    expect(within(nav).getAllByRole('link').map((link) => link.textContent)).toEqual([
      'Usuários',
      'Pré-processamento de áudio',
      'Transcrição',
      'Locutores',
      'Agentes',
      'Tipos de agenda padrão',
      'Saúde',
    ])
    expect(within(nav).getByRole('link', { name: 'Usuários' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByText('Administrator')).toBeInTheDocument()
    expect(screen.getByText('mariana.couto@example.com')).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Principal' })).not.toBeInTheDocument()
    expect(screen.queryByRole('radiogroup', { name: 'Tema' })).not.toBeInTheDocument()
    await waitFor(() => expect(document.title).toBe('Usuários — Admin eclume'))
    expect(http.requests('GET /api/v1/me')).toHaveLength(0)
  })

  it('navigates through the sections and sets the tab title', async () => {
    mockAdminApi()
    renderApp('/admin/usuarios')
    const nav = await screen.findByRole('navigation', { name: 'Plataforma' })
    await userEvent.click(within(nav).getByRole('link', { name: 'Saúde' }))
    expect(within(nav).getByRole('link', { name: 'Saúde' })).toHaveAttribute('aria-current', 'page')
    await waitFor(() => expect(document.title).toBe('Saúde — Admin eclume'))
    await userEvent.click(within(nav).getByRole('link', { name: 'Locutores' }))
    await waitFor(() => expect(document.title).toBe('Locutores — Admin eclume'))
  })

  it('a nonexistent route shows the not-found page inside the panel', async () => {
    mockAdminApi()
    renderApp('/admin/nao-existe')
    const main = await screen.findByRole('main')
    expect(await within(main).findByRole('heading', { level: 1, name: 'Página não encontrada' })).toBeInTheDocument()
    expect(within(main).getByRole('link', { name: 'Ir para Usuários' })).toHaveAttribute('href', '/admin/usuarios')
    expect(screen.getByRole('navigation', { name: 'Plataforma' })).toBeInTheDocument()
  })

  it('has the shell compact menu', async () => {
    mockAdminApi()
    renderApp('/admin/usuarios')
    const button = await screen.findByRole('button', { name: 'Menu' })
    await userEvent.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'true')
  })
})
