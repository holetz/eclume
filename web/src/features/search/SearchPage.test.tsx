import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { fixtures } from '../../test/fixtures'
import { mockFetch } from '../../test/http'
import { preloadRoute, renderApp } from '../../test/render'
import { mockTranscriptApi, RECORDING_ID } from '../../test/transcriptApi'

beforeAll(() => preloadRoute('/busca', '/gravacoes/x'))

afterEach(() => vi.unstubAllGlobals())

const CLIENT = '01928f3a-1c00-7a00-8000-000000000d03'
const PROJECT = '01928f3a-1c00-7a00-8000-000000000d04'

function mockSearch(extra: Parameters<typeof mockFetch>[0] = {}) {
  return mockFetch({
    'GET /api/v1/me': () => fixtures.me(),
    'GET /api/v1/people': () => fixtures.personPage(),
    'GET /api/v1/tags': () => fixtures.tagList(),
    'GET /api/v1/collections': () => fixtures.collectionPage(),
    'GET /api/v1/fields': () => fixtures.fieldPage(),
    'GET /api/v1/search': () => fixtures.searchPage(),
    ...extra,
  })
}

function lastQuery(http: ReturnType<typeof mockFetch>) {
  return new URL(http.requests('GET /api/v1/search').at(-1)!.url).searchParams
}

async function chip(name: RegExp) {
  const filters = await screen.findByRole('group', { name: 'Filtros' })
  return within(filters).findByRole('button', { name })
}

describe('busca', () => {
  it('sem termo nem pessoa não chama a busca', async () => {
    const http = mockSearch()
    renderApp('/busca')
    expect(await screen.findByRole('heading', { level: 1, name: 'Busca' })).toBeInTheDocument()
    expect(screen.getByText('Gravações', { selector: '.kicker' })).toBeInTheDocument()
    expect(await screen.findByText(/Digite um termo ou escolha uma pessoa para buscar/)).toBeInTheDocument()
    expect(http.requests('GET /api/v1/search')).toHaveLength(0)
  })

  it('busca pelos termos, agrupa por gravação com o total e leva à gravação no segundo', async () => {
    const http = mockSearch()
    renderApp('/busca')
    await userEvent.type(await screen.findByRole('searchbox', { name: 'Termos' }), 'turmas')
    await userEvent.click(screen.getByRole('button', { name: 'Buscar' }))

    const results = await screen.findByRole('region', { name: 'Resultados' })
    const group = within(results).getByRole('region', { name: 'Alinhamento do programa de lideranças' })
    expect(group.querySelector('.day-group-head')).toHaveTextContent('Alinhamento do programa de lideranças')
    expect(within(group).getByRole('link', { name: 'Alinhamento do programa de lideranças' })).toHaveAttribute(
      'href',
      `/gravacoes/${RECORDING_ID}`,
    )
    const hits = within(group).getAllByRole('listitem')
    expect(hits).toHaveLength(3)
    expect(hits[0]).toHaveClass('segment')
    expect(hits[0].querySelector('mark')).toHaveTextContent('turmas')
    expect(within(hits[0]).getByText('Mariana Couto')).toHaveClass('speaker')
    expect(within(hits[0]).getByRole('link', { name: /Ouvir em 00:02:02/ })).toHaveAttribute(
      'href',
      `/gravacoes/${RECORDING_ID}?t=122500`,
    )
    expect(screen.getByText('3 trechos em 1 gravação')).toHaveAttribute('role', 'status')
    expect(lastQuery(http).get('q')).toBe('turmas')
  })

  it('as fichas de período, pessoa, tag, coleção e campo viram a consulta', async () => {
    const user = userEvent.setup()
    const http = mockSearch()
    renderApp('/busca?q=turmas')
    await screen.findByText('3 trechos em 1 gravação')

    const period = await chip(/^Período: qualquer$/)
    expect(period).toHaveClass('tag', 'tag-neutral')
    await user.click(period)
    const popover = screen.getByRole('dialog', { name: 'Filtro Período' })
    expect(popover).toHaveClass('menu')
    await user.click(within(popover).getByRole('radio', { name: 'Últimos 30 dias' }))
    await user.click(within(popover).getByRole('button', { name: 'Aplicar' }))
    expect(await chip(/^Período: Últimos 30 dias$/)).toHaveClass('tag-accent')
    await waitFor(() => expect(lastQuery(http).has('from')).toBe(true))
    expect(lastQuery(http).has('to')).toBe(false)

    await user.click(await chip(/^Pessoa:/))
    await user.type(screen.getByRole('combobox', { name: 'Pessoa' }), 'Rafael')
    await user.click(await screen.findByRole('option', { name: /Rafael Lima/ }))
    expect(await chip(/^Pessoa: Rafael Lima$/)).toBeInTheDocument()

    await user.click(await chip(/^Tag:/))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Tag' }), 'cliente-metalurgica (1)')
    await user.click(screen.getByRole('button', { name: 'Aplicar' }))

    await user.click(await chip(/^Coleção:/))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Coleção' }), 'Metalúrgica Serra Azul')
    await user.click(screen.getByRole('button', { name: 'Aplicar' }))

    await user.click(await chip(/^Cliente:/))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Cliente' }), 'Serra Azul')
    await user.click(screen.getByRole('button', { name: 'Aplicar' }))

    await user.click(await chip(/^Projeto:/))
    await user.type(screen.getByRole('textbox', { name: 'Projeto' }), 'Lideranças{Enter}')
    expect(await chip(/^Projeto: Lideranças$/)).toHaveFocus()

    await waitFor(() => expect(lastQuery(http).getAll('field')).toHaveLength(2))
    const query = lastQuery(http)
    expect(query.get('person')).toBe('01928f3a-1c00-7a00-8000-000000000302')
    expect(query.get('tag')).toBe('cliente-metalurgica')
    expect(query.get('collection')).toBe('01928f3a-1c00-7a00-8000-000000000801')
    expect(query.getAll('field')).toEqual([`${CLIENT}:Serra Azul`, `${PROJECT}:Lideranças`])

    // Limpar tira tudo menos os termos.
    await user.click(screen.getByRole('button', { name: 'Limpar' }))
    expect(await chip(/^Cliente: qualquer$/)).toHaveClass('tag-neutral')
    for (const name of [/^Período: qualquer$/, /^Pessoa: qualquer$/, /^Tag: qualquer$/, /^Projeto: qualquer$/]) {
      expect(await chip(name)).toBeInTheDocument()
    }
    expect(screen.getByRole('searchbox', { name: 'Termos' })).toHaveValue('turmas')
  }, 20_000)

  it('Esc e o clique fora fecham a ficha sem aplicar', async () => {
    const user = userEvent.setup()
    mockSearch()
    renderApp('/busca?q=turmas')
    const tag = await chip(/^Tag:/)
    await user.click(tag)
    expect(tag).toHaveAttribute('aria-expanded', 'true')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(tag).toHaveFocus()
    await user.click(tag)
    await user.click(screen.getByRole('heading', { level: 1, name: 'Busca' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('lê os filtros da URL e avisa quando nada é encontrado', async () => {
    const http = mockSearch({ 'GET /api/v1/search': () => ({ items: [], next_cursor: null }) })
    renderApp(`/busca?q=inexistente&ate=2026-09-18&campo=${CLIENT}:Vale%20Verde`)
    expect(await screen.findByText('Nenhum trecho encontrado com esses filtros.')).toBeInTheDocument()
    expect(screen.getByRole('searchbox', { name: 'Termos' })).toHaveValue('inexistente')
    expect(await chip(/^Período: até 18\/09\/2026$/)).toHaveClass('tag-accent')
    expect(await chip(/^Cliente: Vale Verde$/)).toHaveClass('tag-accent')
    const query = new URL(http.requests('GET /api/v1/search')[0].url).searchParams
    expect(query.get('to')).toBe(new Date(2026, 8, 19).toISOString())
    expect(query.getAll('field')).toEqual([`${CLIENT}:Vale Verde`])
  })

  it('pagina os resultados e o total diz quando há mais', async () => {
    const first = { ...fixtures.searchPage(), next_cursor: 'c2' }
    const second = { items: [fixtures.searchPage().items[0]], next_cursor: null }
    second.items[0].segment.id = 'seg-0012'
    mockSearch({
      'GET /api/v1/search': (request) => (new URL(request.url).searchParams.get('cursor') === 'c2' ? second : first),
    })
    renderApp('/busca?q=turmas')
    expect(await screen.findByText('3 trechos em 1 gravação ou mais')).toBeInTheDocument()
    await userEvent.click(await screen.findByRole('button', { name: 'Mais resultados' }))
    expect(await screen.findByText('4 trechos em 1 gravação')).toBeInTheDocument()
    const results = screen.getByRole('region', { name: 'Resultados' })
    expect(within(results).getAllByRole('listitem')).toHaveLength(4)
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
