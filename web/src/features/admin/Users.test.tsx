import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Schemas } from '../../api/client'
import { fixtures } from '../../test/fixtures'
import { mockFetch } from '../../test/http'
import { renderApp } from '../../test/render'

afterEach(() => vi.unstubAllGlobals())

const PAULO_ID = '01928f3a-1c00-7a00-8000-000000000102'

/** As duas páginas do cursor: a fixture e uma conta desativada depois dela. */
function pages(): Schemas['AdminUserPage'][] {
  const first = fixtures.adminUserPage()
  const second = fixtures.adminUserPage()
  first.next_cursor = 'pagina-2'
  second.items = [
    {
      ...second.items[0],
      id: '01928f3a-1c00-7a00-8000-000000000103',
      name: 'Júlia Araújo',
      email: 'julia.araujo@exemplo.org',
      active: false,
      recording_count: 0,
    },
  ]
  return [first, second]
}

function mockUsersApi(extra: Parameters<typeof mockFetch>[0] = {}) {
  const [first, second] = pages()
  return mockFetch({
    'GET /api/v1/admin/me': () => fixtures.adminMe(),
    'GET /api/v1/admin/users': (request) =>
      new URL(request.url).searchParams.get('cursor') === 'pagina-2' ? second : first,
    ...extra,
  })
}

describe('Usuários', () => {
  it('lê todas as páginas e mostra a tabela do DS com o contador', async () => {
    const http = mockUsersApi()
    renderApp('/admin/usuarios')
    expect(await screen.findByRole('heading', { level: 1, name: 'Usuários' })).toBeInTheDocument()
    expect(screen.getByText('Painel de administração')).toHaveClass('kicker')
    const julia = await screen.findByRole('row', { name: /Júlia Araújo/ })
    expect(within(julia).getByText('Desativada')).toBeInTheDocument()
    const paulo = screen.getByRole('row', { name: /Paulo Andrade/ })
    expect(within(paulo).getByText('paulo.andrade@example.com')).toHaveClass('mono')
    expect(within(paulo).getByText('12')).toHaveClass('tabular')
    expect(within(paulo).getByText('11 set 2026')).toBeInTheDocument()
    expect(within(paulo).getByText('Ativa')).toHaveClass('badge-success')
    expect(screen.getByText('3 contas · 2 ativas')).toBeInTheDocument()
    const requests = http.requests('GET /api/v1/admin/users').map((r) => new URL(r.url).searchParams)
    expect(requests.map((q) => [q.get('limit'), q.get('cursor')])).toEqual([
      ['200', null],
      ['200', 'pagina-2'],
    ])
  })

  it('busca por nome ou e-mail, sem acento e sem caixa', async () => {
    mockUsersApi()
    renderApp('/admin/usuarios')
    const search = await screen.findByRole('searchbox', { name: 'Buscar por nome ou e-mail' })
    await screen.findByRole('row', { name: /Júlia Araújo/ })
    await userEvent.type(search, 'JULIA')
    expect(screen.getByRole('row', { name: /Júlia Araújo/ })).toBeInTheDocument()
    expect(screen.queryByRole('row', { name: /Paulo Andrade/ })).not.toBeInTheDocument()
    // O contador é da lista inteira.
    expect(screen.getByText('3 contas · 2 ativas')).toBeInTheDocument()
    await userEvent.clear(search)
    await userEvent.type(search, 'example')
    expect(screen.getAllByRole('row')).toHaveLength(3)
    await userEvent.clear(search)
    await userEvent.type(search, 'ninguém')
    expect(screen.getByText('Nenhuma conta com “ninguém”.')).toBeInTheDocument()
  })

  it('desativa só depois de confirmar no diálogo', async () => {
    const paulo = fixtures.adminUserPage().items[1]
    const http = mockUsersApi({ 'PATCH /api/v1/admin/users/:id': () => ({ ...paulo, active: false }) })
    renderApp('/admin/usuarios')
    await userEvent.click(await screen.findByRole('button', { name: 'Desativar Paulo Andrade' }))
    const dialog = screen.getByRole('dialog', { name: 'Desativar Paulo Andrade?' })
    expect(dialog).toHaveTextContent('As sessões são encerradas e os tokens de acesso, revogados.')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(http.requests('PATCH /api/v1/admin/users/:id')).toHaveLength(0)

    await userEvent.click(screen.getByRole('button', { name: 'Desativar Paulo Andrade' }))
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Desativar' }))
    const row = screen.getByRole('row', { name: /Paulo Andrade/ })
    expect(await within(row).findByText('Desativada')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    const request = http.requests('PATCH /api/v1/admin/users/:id')[0]
    expect(new URL(request.url).pathname).toBe(`/api/v1/admin/users/${PAULO_ID}`)
    expect(await request.json()).toEqual({ active: false })
    expect(screen.getByText('3 contas · 1 ativa')).toBeInTheDocument()
  })

  it('reativa na hora', async () => {
    const [, second] = pages()
    const http = mockUsersApi({ 'PATCH /api/v1/admin/users/:id': () => ({ ...second.items[0], active: true }) })
    renderApp('/admin/usuarios')
    await userEvent.click(await screen.findByRole('button', { name: 'Reativar Júlia Araújo' }))
    expect(await within(screen.getByRole('row', { name: /Júlia Araújo/ })).findByText('Ativa')).toBeInTheDocument()
    expect(await http.requests('PATCH /api/v1/admin/users/:id')[0].json()).toEqual({ active: true })
  })

  it('sem contas, aponta o cadastro', async () => {
    mockFetch({
      'GET /api/v1/admin/me': () => fixtures.adminMe(),
      'GET /api/v1/admin/users': () => ({ items: [], next_cursor: null }),
    })
    renderApp('/admin/usuarios')
    expect(await screen.findByText('Nenhuma conta ainda. O cadastro fica em /cadastro.')).toBeInTheDocument()
  })
})
