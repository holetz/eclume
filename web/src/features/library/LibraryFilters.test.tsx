import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { STORAGE_KEYS } from '../../app/storage'
import { fixtures } from '../../test/fixtures'
import { mockFetch } from '../../test/http'
import { renderApp } from '../../test/render'

afterEach(() => {
  vi.unstubAllGlobals()
})

const WEEK = '/?visao=semana&data=2026-09-21'
const CLIENT = '01928f3a-1c00-7a00-8000-000000000d03'
const PROJECT = '01928f3a-1c00-7a00-8000-000000000d04'
const SERRA = '01928f3a-1c00-7a00-8000-000000000801'

function mockLibrary() {
  return mockFetch({
    'GET /api/v1/me': () => fixtures.me(),
    'GET /api/v1/recordings': () => fixtures.recordingWeekPage(),
    'GET /api/v1/tags': () => fixtures.tagList(),
    'GET /api/v1/collections': () => fixtures.collectionPage(),
    'GET /api/v1/fields': () => fixtures.fieldPage(),
    'GET /api/v1/people': () => fixtures.personPage(),
  })
}

/** A query da última consulta da semana (as leituras incrementais `?since=` ficam de fora). */
function lastQuery(http: ReturnType<typeof mockFetch>): URLSearchParams {
  const requests = http
    .requests('GET /api/v1/recordings')
    .filter((request) => !new URL(request.url).searchParams.has('since'))
  return new URL(requests[requests.length - 1].url).searchParams
}

function group(name: string) {
  return screen.getByRole('group', { name })
}

describe('painel de filtros', () => {
  it('filtra pelos participantes: empresa, área e tag de um mesmo participante', async () => {
    const http = mockFetch({
      'GET /api/v1/me': () => fixtures.me(),
      'GET /api/v1/recordings': () => fixtures.recordingWeekPage(),
      'GET /api/v1/tags': () => fixtures.tagList(),
      'GET /api/v1/collections': () => ({ items: [], next_cursor: null }),
      'GET /api/v1/fields': () => fixtures.fieldPage(),
      'GET /api/v1/people': () => fixtures.personPage(),
      'GET /api/v1/people/facets': () => ({
        companies: [
          { value: 'Agro Sul', count: 1 },
          { value: 'Metalúrgica Serra Azul', count: 2 },
        ],
        departments: [],
        tags: [{ value: 'diretoria', count: 1 }],
      }),
    })
    renderApp(WEEK)
    const participants = await screen.findByRole('group', { name: 'Participantes' })
    expect(within(participants).queryByRole('group', { name: 'Área' })).not.toBeInTheDocument()
    await userEvent.click(within(participants).getByRole('checkbox', { name: 'Agro Sul' }))
    await userEvent.click(within(participants).getByRole('checkbox', { name: 'diretoria' }))
    await waitFor(() => expect(lastQuery(http).getAll('person_tag')).toEqual(['diretoria']))
    expect(lastQuery(http).getAll('person_company')).toEqual(['Agro Sul'])

    await userEvent.click(within(participants).getByRole('checkbox', { name: 'Agro Sul' }))
    await waitFor(() => expect(lastQuery(http).getAll('person_company')).toEqual([]))
    expect(within(participants).getByRole('checkbox', { name: 'Agro Sul' })).not.toBeChecked()
  })

  it('mostra os grupos do DS, com os campos próprios do usuário', async () => {
    mockLibrary()
    renderApp(WEEK)
    const panel = await screen.findByRole('complementary', { name: 'Filtros' })
    expect(panel).toHaveClass('filters')
    expect(panel.closest('.with-filters')).not.toBeNull()

    expect(within(group('Tipo')).getByRole('checkbox', { name: 'Reuniões' })).toBeChecked()
    expect(within(group('Tipo')).getByRole('checkbox', { name: 'Notas' })).toBeChecked()
    expect(within(group('Situação')).getAllByRole('checkbox')).toHaveLength(3)
    expect(await within(panel).findByRole('button', { name: 'cliente-metalurgica' })).toHaveAttribute('aria-pressed', 'false')
    expect(within(group('Pessoas')).getByRole('combobox', { name: 'Filtrar por pessoa' })).toBeInTheDocument()
    expect(await within(panel).findByRole('checkbox', { name: 'Metalúrgica Serra Azul' })).not.toBeChecked()
    expect(within(group('Coleções')).getByRole('link', { name: 'Gerenciar coleções' })).toHaveAttribute('href', '/colecoes')
    // Os embutidos (título e tags) não viram grupo; "Cliente" é escolha e "Projeto" é texto.
    expect(await within(panel).findByRole('group', { name: 'Cliente' })).toBeInTheDocument()
    expect(within(group('Cliente')).getByRole('checkbox', { name: 'Serra Azul' })).toBeInTheDocument()
    expect(within(group('Projeto')).getByRole('textbox', { name: 'Projeto' })).toHaveAttribute('placeholder', 'Qualquer valor')
    expect(within(panel).queryByRole('group', { name: 'Título' })).not.toBeInTheDocument()
  })

  it('cada filtro vai para a URL e para a requisição, e Limpar mantém a visão e a data', async () => {
    const user = userEvent.setup()
    const http = mockLibrary()
    renderApp(WEEK)
    const panel = await screen.findByRole('complementary', { name: 'Filtros' })

    await user.click(within(group('Tipo')).getByRole('checkbox', { name: 'Notas' }))
    await waitFor(() => expect(lastQuery(http).getAll('kind')).toEqual(['meeting']))
    // O último marcado do grupo não sai.
    expect(within(group('Tipo')).getByRole('checkbox', { name: 'Reuniões' })).toBeDisabled()

    await user.click(within(group('Situação')).getByRole('checkbox', { name: 'Pronta' }))
    await waitFor(() => expect(lastQuery(http).getAll('status')).toEqual(['uploading', 'queued', 'processing', 'failed']))

    await user.click(await within(panel).findByRole('button', { name: 'cliente-metalurgica' }))
    await waitFor(() => expect(lastQuery(http).getAll('tag')).toEqual(['cliente-metalurgica']))
    expect(within(panel).getByRole('button', { name: 'cliente-metalurgica' })).toHaveAttribute('aria-pressed', 'true')

    await user.click(within(group('Coleções')).getByRole('checkbox', { name: 'Metalúrgica Serra Azul' }))
    await waitFor(() => expect(lastQuery(http).getAll('collection')).toEqual([SERRA]))

    await user.click(within(group('Cliente')).getByRole('checkbox', { name: 'Serra Azul' }))
    const project = within(group('Projeto')).getByRole('textbox', { name: 'Projeto' })
    await user.type(project, 'Programa 2026{Enter}')
    await waitFor(() =>
      expect(lastQuery(http).getAll('field')).toEqual([`${CLIENT}:Serra Azul`, `${PROJECT}:Programa 2026`]),
    )

    const combobox = within(group('Pessoas')).getByRole('combobox', { name: 'Filtrar por pessoa' })
    await user.type(combobox, 'Rafael')
    await user.click(await screen.findByRole('option', { name: /Rafael Lima/ }))
    await waitFor(() => expect(lastQuery(http).getAll('person')).toEqual(['01928f3a-1c00-7a00-8000-000000000302']))
    expect(within(group('Pessoas')).getByText('Rafael Lima')).toBeInTheDocument()

    expect(within(panel).getByRole('heading', { name: /Filtros/ })).toHaveTextContent('Filtros8')
    await user.click(within(panel).getByRole('button', { name: 'Limpar filtros' }))
    // A consulta sem filtros já estava em cache: a prova é o painel zerado e a requisição limpa de antes.
    await waitFor(() => expect(within(panel).getByRole('heading', { name: /Filtros/ })).toHaveTextContent(/^Filtros$/))
    const query = http
      .requests('GET /api/v1/recordings')
      .map((request) => new URL(request.url).searchParams)
      .find((params) => params.has('from') && !params.has('kind') && !params.has('since'))!
    expect([...query.keys()].sort()).toEqual(['from', 'limit', 'sort', 'to'])
    expect(query.get('from')).toBe('2026-09-21T03:00:00.000Z')
    expect(screen.getByRole('radio', { name: 'Semana' })).toBeChecked()
  }, 20_000)

  it('recolhe e lembra o estado, e a biblioteca volta à última visão e aos últimos filtros', async () => {
    const user = userEvent.setup()
    const http = mockLibrary()
    const { unmount } = renderApp(`${WEEK}&tag=programa-liderancas`)
    const collapse = await screen.findByRole('button', { name: 'Recolher filtros' })
    expect(collapse).toHaveAttribute('aria-expanded', 'true')
    await user.click(collapse)
    const expand = screen.getByRole('button', { name: 'Expandir filtros' })
    expect(expand).toHaveAttribute('aria-expanded', 'false')
    expect(expand.closest('.with-filters')).toHaveAttribute('data-collapsed', 'true')
    expect(localStorage.getItem(STORAGE_KEYS.filtersCollapsed)).toBe('1')
    expect(localStorage.getItem(`${STORAGE_KEYS.lastLibrary}:${fixtures.me().user.id}`)).toBe(
      'visao=semana&data=2026-09-21&tag=programa-liderancas',
    )
    unmount()

    renderApp('/')
    expect(await screen.findByRole('button', { name: 'Expandir filtros' })).toBeInTheDocument()
    expect(await screen.findByText('21–27 de setembro de 2026')).toBeInTheDocument()
    await waitFor(() => expect(lastQuery(http).getAll('tag')).toEqual(['programa-liderancas']))
  })

  it('em tela estreita, os filtros abrem num diálogo pela barra', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(max-width: 56rem)' }))
    const user = userEvent.setup()
    const http = mockLibrary()
    renderApp('/?visao=lista&tag=programa-liderancas')
    await user.click(await screen.findByRole('button', { name: 'Filtros (1)' }))
    expect(screen.queryByRole('complementary', { name: 'Filtros' })).not.toBeInTheDocument()
    const dialog = screen.getByRole('dialog', { name: 'Filtros' })
    await user.click(within(dialog).getByRole('checkbox', { name: 'Notas' }))
    await waitFor(() => expect(lastQuery(http).getAll('kind')).toEqual(['meeting']))
    await user.click(within(dialog).getByRole('button', { name: 'Ver gravações' }))
    expect(screen.getByRole('button', { name: 'Filtros (2)' })).toBeInTheDocument()
  })
})
