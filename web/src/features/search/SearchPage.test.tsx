import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fixtures } from '../../test/fixtures'
import { mockFetch } from '../../test/http'
import { renderApp } from '../../test/render'
import { mockTranscriptApi, RECORDING_ID } from '../../test/transcriptApi'

afterEach(() => vi.unstubAllGlobals())

function mockSearch(extra: Parameters<typeof mockFetch>[0] = {}) {
  return mockFetch({
    'GET /api/v1/me': () => fixtures.me(),
    'GET /api/v1/people': () => fixtures.personPage(),
    'GET /api/v1/tags': () => fixtures.tagList(),
    'GET /api/v1/collections': () => fixtures.collectionPage(),
    'GET /api/v1/search': () => fixtures.searchPage(),
    ...extra,
  })
}

describe('busca', () => {
  it('sem termo nem pessoa não chama a busca', async () => {
    const http = mockSearch()
    renderApp('/busca')
    expect(await screen.findByText('Digite um termo ou escolha uma pessoa para buscar.')).toBeInTheDocument()
    expect(http.requests('GET /api/v1/search')).toHaveLength(0)
  })

  it('busca com filtros, destaca os termos e leva à gravação no segundo', async () => {
    const http = mockSearch()
    renderApp('/busca')
    await userEvent.type(await screen.findByLabelText('Termos'), 'turmas')
    await screen.findByRole('option', { name: 'Rafael Lima' })
    await userEvent.selectOptions(screen.getByLabelText('Pessoa'), 'Rafael Lima')
    await userEvent.selectOptions(screen.getByLabelText('Tag'), 'cliente-metalurgica (1)')
    await userEvent.selectOptions(await screen.findByLabelText('Coleção'), 'Metalúrgica Serra Azul')
    await userEvent.type(screen.getByLabelText('De'), '2026-09-01')
    await userEvent.click(screen.getByRole('button', { name: 'Buscar' }))

    const results = await screen.findByRole('list', { name: 'Resultados' })
    const hits = within(results).getAllByRole('listitem')
    expect(hits).toHaveLength(3)
    expect(hits[0].querySelector('mark')).toHaveTextContent('turmas')
    expect(within(hits[0]).getByText('Mariana Couto')).toBeInTheDocument()
    expect(within(hits[0]).getByRole('link')).toHaveAttribute('href', `/gravacoes/${RECORDING_ID}?t=122500`)
    expect(within(hits[2]).getByText('Locutor 2')).toBeInTheDocument()

    const query = new URL(http.requests('GET /api/v1/search').at(-1)!.url).searchParams
    expect(query.get('q')).toBe('turmas')
    expect(query.get('person')).toBe('01928f3a-1c00-7a00-8000-000000000302')
    expect(query.get('tag')).toBe('cliente-metalurgica')
    expect(query.get('collection')).toBe('01928f3a-1c00-7a00-8000-000000000801')
    expect(query.get('from')).toBe(new Date(2026, 8, 1).toISOString())
  })

  it('lê os filtros da URL e avisa quando nada é encontrado', async () => {
    const http = mockSearch({ 'GET /api/v1/search': () => ({ items: [], next_cursor: null }) })
    renderApp('/busca?q=inexistente&ate=2026-09-18')
    expect(await screen.findByText('Nenhum trecho encontrado com esses filtros.')).toBeInTheDocument()
    expect(screen.getByLabelText('Termos')).toHaveValue('inexistente')
    const query = new URL(http.requests('GET /api/v1/search')[0].url).searchParams
    expect(query.get('to')).toBe(new Date(2026, 8, 19).toISOString())
  })

  it('pagina os resultados', async () => {
    const first = { ...fixtures.searchPage(), next_cursor: 'c2' }
    const second = { items: [fixtures.searchPage().items[0]], next_cursor: null }
    second.items[0].segment.id = 'seg-0012'
    mockSearch({
      'GET /api/v1/search': (request) => (new URL(request.url).searchParams.get('cursor') === 'c2' ? second : first),
    })
    renderApp('/busca?q=turmas')
    await userEvent.click(await screen.findByRole('button', { name: 'Mais resultados' }))
    const results = screen.getByRole('list', { name: 'Resultados' })
    expect(await within(results).findAllByRole('listitem')).toHaveLength(4)
  })
})

describe('gravação aberta pela busca', () => {
  it('posiciona o áudio e destaca a fala do instante em ?t=', async () => {
    mockTranscriptApi()
    renderApp(`/gravacoes/${RECORDING_ID}?t=122500`)
    const falas = await screen.findByRole('list', { name: 'Falas' })
    const items = within(falas).getAllByRole('listitem')
    expect(items[9].querySelector('.segment')).toHaveAttribute('aria-current', 'true')
    expect((screen.getByLabelText('Áudio da gravação') as HTMLAudioElement).currentTime).toBe(122.5)
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
  })
})
