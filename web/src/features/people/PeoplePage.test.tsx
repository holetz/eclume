import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fixtures } from '../../test/fixtures'
import { empty, mockFetch, problem } from '../../test/http'
import { renderApp } from '../../test/render'

afterEach(() => vi.unstubAllGlobals())

const RAFAEL = '01928f3a-1c00-7a00-8000-000000000302'

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
    expect(screen.queryByText(/organização/i)).not.toBeInTheDocument()

    await userEvent.type(screen.getByRole('searchbox', { name: 'Buscar pessoas' }), 'raf')
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(3))
    const queries = http.requests('GET /api/v1/people').map((r) => new URL(r.url).searchParams.get('q'))
    expect(queries).toContain('raf')
  })

  it('cadastra uma pessoa na linha de cadastro com Enter e continua na lista', async () => {
    const created = { ...fixtures.person(), name: 'Rafael Lima' }
    const http = mockFetch({
      'GET /api/v1/me': () => fixtures.me(),
      'GET /api/v1/people': () =>
        http.requests('POST /api/v1/people').length ? { items: [created], next_cursor: null } : { items: [], next_cursor: null },
      'POST /api/v1/people': () => created,
    })
    renderApp('/pessoas')
    expect(await screen.findByText('Nenhuma pessoa cadastrada ainda.')).toBeInTheDocument()
    const name = screen.getByRole('textbox', { name: 'Nome da nova pessoa' })
    await userEvent.type(name, 'Rafael Lima')
    await userEvent.type(screen.getByRole('textbox', { name: 'E-mail da nova pessoa' }), 'rafael.lima@example.com{Enter}')
    expect(await screen.findByRole('link', { name: 'Rafael Lima' })).toBeInTheDocument()
    expect(await http.requests('POST /api/v1/people')[0].json()).toEqual({
      name: 'Rafael Lima',
      email: 'rafael.lima@example.com',
      notes: null,
    })
    expect(name).toHaveValue('')
    expect(screen.getByRole('heading', { level: 1, name: 'Pessoas' })).toBeInTheDocument()
  })

  it('mostra o e-mail repetido na própria linha', async () => {
    mockFetch({
      'GET /api/v1/me': () => fixtures.me(),
      'GET /api/v1/people': () => fixtures.personPage(),
      'POST /api/v1/people': () => problem('conflict', 409),
    })
    renderApp('/pessoas')
    await userEvent.type(await screen.findByRole('textbox', { name: 'Nome da nova pessoa' }), 'Rafael')
    const email = screen.getByRole('textbox', { name: 'E-mail da nova pessoa' })
    await userEvent.type(email, 'rafael.lima@example.com')
    await userEvent.click(screen.getByRole('button', { name: 'Adicionar' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Já existe uma pessoa com este e-mail.')
    expect(email).toHaveAttribute('aria-invalid', 'true')
    expect(email.closest('tr')).toContainElement(screen.getByRole('alert'))
  })
})

describe('página da pessoa', () => {
  function mockPerson(extra: Parameters<typeof mockFetch>[0] = {}) {
    return mockFetch({
      'GET /api/v1/me': () => fixtures.me(),
      'GET /api/v1/people/:id': () => fixtures.person(),
      'GET /api/v1/people/:id/transcripts': () => fixtures.transcriptPage(),
      'GET /api/v1/people/:id/voiceprint': () => fixtures.voiceprint(),
      'GET /api/v1/search': () => fixtures.searchPage(),
      ...extra,
    })
  }

  it('mostra as transcrições e as falas, que abrem a gravação no segundo', async () => {
    const http = mockPerson()
    renderApp(`/pessoas/${RAFAEL}`)
    expect(await screen.findByRole('heading', { level: 1, name: 'Rafael Lima' })).toBeInTheDocument()
    expect(screen.getByText('Gerente de RH da Metalúrgica Serra Azul.')).toBeInTheDocument()
    const transcripts = await screen.findByRole('list', { name: 'Transcrições da pessoa' })
    expect(within(transcripts).getAllByRole('link')[0]).toHaveAttribute('href', expect.stringMatching(/^\/gravacoes\//))
    const falas = await screen.findByRole('list', { name: 'Falas da pessoa' })
    expect(within(falas).getAllByRole('listitem')).toHaveLength(3)
    expect(within(falas).getByRole('link', { name: /02:02/ })).toHaveAttribute(
      'href',
      '/gravacoes/01928f3a-1c00-7a00-8000-000000000401?t=122500',
    )
    const search = http.requests('GET /api/v1/search')[0]
    expect(new URL(search.url).searchParams.get('person')).toBe(RAFAEL)
  })

  it('edita e exclui a pessoa', async () => {
    let current = fixtures.person()
    const http = mockPerson({
      'GET /api/v1/people/:id': () => current,
      'PATCH /api/v1/people/:id': async (request) => (current = { ...current, ...((await request.json()) as object) }),
      'DELETE /api/v1/people/:id': () => empty(),
      'GET /api/v1/people': () => fixtures.personPage(),
    })
    renderApp(`/pessoas/${RAFAEL}`)
    await userEvent.click(await screen.findByRole('button', { name: 'Editar' }))
    const nome = screen.getByLabelText('Nome')
    await userEvent.clear(nome)
    await userEvent.type(nome, 'Rafael Lima Souza')
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Rafael Lima Souza' })).toBeInTheDocument()
    expect(await http.requests('PATCH /api/v1/people/:id')[0].json()).toMatchObject({ name: 'Rafael Lima Souza' })

    await userEvent.click(screen.getByRole('button', { name: 'Excluir' }))
    await userEvent.click(screen.getByRole('button', { name: 'Confirmar exclusão' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Pessoas' })).toBeInTheDocument()
    expect(http.requests('DELETE /api/v1/people/:id')).toHaveLength(1)
  })
})
