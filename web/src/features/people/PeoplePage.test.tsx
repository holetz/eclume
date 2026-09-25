import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fixtures } from '../../test/fixtures'
import { empty, mockFetch, problem } from '../../test/http'
import { renderApp } from '../../test/render'

afterEach(() => vi.unstubAllGlobals())

const RAFAEL = '01928f3a-1c00-7a00-8000-000000000302'

describe('diretório de pessoas', () => {
  it('lista as pessoas com contagem e filtra por nome', async () => {
    const http = mockFetch({
      'GET /api/v1/me': () => fixtures.me(),
      'GET /api/v1/people': (request) => {
        const page = fixtures.personPage()
        const q = new URL(request.url).searchParams.get('q')
        return q ? { ...page, items: page.items.filter((p) => p.name.toLowerCase().startsWith(q)) } : page
      },
    })
    renderApp('/pessoas')
    const list = await screen.findByRole('list', { name: 'Pessoas' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(3)
    expect(within(list).getByRole('link', { name: 'Mariana Couto' })).toHaveAttribute(
      'href',
      '/pessoas/01928f3a-1c00-7a00-8000-000000000301',
    )
    expect(within(list).getByText('14 transcrições')).toBeInTheDocument()
    expect(within(list).getByText('0 transcrições')).toBeInTheDocument()

    await userEvent.type(screen.getByLabelText('Buscar por nome ou e-mail'), 'raf')
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Pessoas' })).getAllByRole('listitem')).toHaveLength(1))
    const queries = http.requests('GET /api/v1/people').map((r) => new URL(r.url).searchParams.get('q'))
    expect(queries).toContain('raf')
  })

  it('cadastra uma pessoa e abre a página dela', async () => {
    const http = mockFetch({
      'GET /api/v1/me': () => fixtures.me(),
      'GET /api/v1/people': () => ({ items: [], next_cursor: null }),
      'POST /api/v1/people': () => fixtures.person(),
      'GET /api/v1/people/:id': () => fixtures.person(),
      'GET /api/v1/people/:id/transcripts': () => ({ items: [], next_cursor: null }),
      'GET /api/v1/people/:id/voiceprint': () => fixtures.voiceprint(),
      'GET /api/v1/search': () => ({ items: [], next_cursor: null }),
    })
    renderApp('/pessoas')
    expect(await screen.findByText('Nenhuma pessoa cadastrada ainda.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Cadastrar pessoa' }))
    await userEvent.type(screen.getByLabelText('Nome'), 'Rafael Lima')
    await userEvent.type(screen.getByLabelText('E-mail'), 'rafael.lima@example.com')
    await userEvent.click(screen.getByRole('button', { name: 'Cadastrar' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Rafael Lima' })).toBeInTheDocument()
    expect(await http.requests('POST /api/v1/people')[0].json()).toEqual({
      name: 'Rafael Lima',
      email: 'rafael.lima@example.com',
      notes: null,
    })
  })

  it('mostra o erro de um e-mail repetido', async () => {
    mockFetch({
      'GET /api/v1/me': () => fixtures.me(),
      'GET /api/v1/people': () => fixtures.personPage(),
      'POST /api/v1/people': () => problem('conflict', 409),
    })
    renderApp('/pessoas')
    await userEvent.click(await screen.findByRole('button', { name: 'Cadastrar pessoa' }))
    await userEvent.type(screen.getByLabelText('Nome'), 'Rafael')
    await userEvent.click(screen.getByRole('button', { name: 'Cadastrar' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/Conflito/)
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
