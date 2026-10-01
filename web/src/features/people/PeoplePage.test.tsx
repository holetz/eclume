import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { fixtures } from '../../test/fixtures'
import { mockFetch, problem } from '../../test/http'
import { preloadRoute, renderApp } from '../../test/render'

beforeAll(() => preloadRoute('/pessoas'))

afterEach(() => vi.unstubAllGlobals())

describe('diretório de pessoas', () => {
  it('lista as pessoas numa tabela com contagem e filtra por nome', async () => {
    const http = mockFetch({
      'GET /api/v1/me': () => fixtures.me(),
      'GET /api/v1/people': (request) => {
        const page = fixtures.personPage()
        const q = new URL(request.url).searchParams.get('q')
        return q ? { ...page, items: page.items.filter((p) => p.name.toLowerCase().startsWith(q)) } : page
      },
    })
    renderApp('/pessoas')
    expect(await screen.findByRole('heading', { level: 1, name: 'Pessoas' })).toBeInTheDocument()
    const table = await screen.findByRole('table', { name: 'Pessoas' })
    const link = await within(table).findByRole('link', { name: 'Mariana Couto' })
    expect(link).toHaveAttribute('href', '/pessoas/01928f3a-1c00-7a00-8000-000000000301')
    expect(link.closest('.speaker')).toHaveClass('speaker-2')
    // A primeira linha é o cadastro; depois, uma linha por pessoa.
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(4)
    expect(within(rows[2]).getByText('14')).toHaveClass('tabular')
    expect(within(table).getByRole('columnheader', { name: 'Amostras de voz' })).toBeInTheDocument()
    expect(within(table).getByRole('columnheader', { name: 'Empresa' })).toBeInTheDocument()
    // O e-mail quase nunca importa: começa escondido.
    expect(within(table).queryByRole('columnheader', { name: 'E-mail' })).not.toBeInTheDocument()

    await userEvent.type(screen.getByRole('searchbox', { name: 'Buscar pessoas' }), 'raf')
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(3))
    const queries = http.requests('GET /api/v1/people').map((r) => new URL(r.url).searchParams.get('q'))
    expect(queries).toContain('raf')
  })

  it('cadastra uma pessoa na linha de cadastro com nome e empresa, com Enter', async () => {
    const created = { ...fixtures.person(), name: 'Rafael Lima' }
    const http = mockFetch({
      'GET /api/v1/me': () => fixtures.me(),
      'GET /api/v1/people/facets': () => ({ companies: [], departments: [], tags: [] }),
      'GET /api/v1/people': () =>
        http.requests('POST /api/v1/people').length ? { items: [created], next_cursor: null } : { items: [], next_cursor: null },
      'POST /api/v1/people': () => created,
    })
    renderApp('/pessoas')
    expect(await screen.findByText('Nenhuma pessoa cadastrada ainda.')).toBeInTheDocument()
    const name = screen.getByRole('textbox', { name: 'Nome da nova pessoa' })
    await userEvent.type(name, 'Rafael Lima')
    await userEvent.type(screen.getByRole('combobox', { name: 'Empresa da nova pessoa' }), 'Serra Azul{Enter}')
    expect(await screen.findByRole('link', { name: 'Rafael Lima' })).toBeInTheDocument()
    expect(await http.requests('POST /api/v1/people')[0].json()).toEqual({ name: 'Rafael Lima', company: 'Serra Azul' })
    expect(name).toHaveValue('')
    expect(screen.getByRole('heading', { level: 1, name: 'Pessoas' })).toBeInTheDocument()
  })

  it('mostra o erro do cadastro na própria linha', async () => {
    mockFetch({
      'GET /api/v1/me': () => fixtures.me(),
      'GET /api/v1/people': () => fixtures.personPage(),
      'POST /api/v1/people': () => problem('conflict', 409),
    })
    renderApp('/pessoas')
    const name = await screen.findByRole('textbox', { name: 'Nome da nova pessoa' })
    await userEvent.type(name, 'Rafael')
    await userEvent.click(screen.getByRole('button', { name: 'Adicionar' }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(name.closest('tr')).toContainElement(screen.getByRole('alert'))
  })

  it('escolhe as colunas no menu Colunas e lembra a escolha', async () => {
    mockFetch({
      'GET /api/v1/me': () => fixtures.me(),
      'GET /api/v1/people': () => fixtures.personPage(),
    })
    const { unmount } = renderApp('/pessoas')
    const table = await screen.findByRole('table', { name: 'Pessoas' })
    await userEvent.click(screen.getByRole('button', { name: 'Colunas' }))
    const panel = screen.getByRole('group', { name: 'Mostrar colunas' })
    expect(within(panel).getByRole('checkbox', { name: 'E-mail' })).not.toBeChecked()
    await userEvent.click(within(panel).getByRole('checkbox', { name: 'E-mail' }))
    await userEvent.click(within(panel).getByRole('checkbox', { name: 'Amostras de voz' }))
    expect(within(table).getByRole('columnheader', { name: 'E-mail' })).toBeInTheDocument()
    expect(within(table).queryByRole('columnheader', { name: 'Amostras de voz' })).not.toBeInTheDocument()
    expect(within(table).getByText('juliana.prado@example.com')).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('group', { name: 'Mostrar colunas' })).not.toBeInTheDocument()

    unmount()
    renderApp('/pessoas')
    const again = await screen.findByRole('table', { name: 'Pessoas' })
    expect(within(again).getByRole('columnheader', { name: 'E-mail' })).toBeInTheDocument()
    expect(within(again).queryByRole('columnheader', { name: 'Amostras de voz' })).not.toBeInTheDocument()
    window.localStorage.clear()
  })
})
