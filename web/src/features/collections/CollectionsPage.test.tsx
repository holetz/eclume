import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Schemas } from '../../api/client'
import { fixtures } from '../../test/fixtures'
import { empty, mockFetch } from '../../test/http'
import { preloadRoute, renderApp } from '../../test/render'

beforeAll(() => preloadRoute('/colecoes'))

afterEach(() => vi.unstubAllGlobals())

const SERRA = '01928f3a-1c00-7a00-8000-000000000801'

/** A stateful collections API, like the server. */
function mockCollections(initial: Schemas['Collection'][] = fixtures.collectionPage().items) {
  let items = initial
  return mockFetch({
    'GET /api/v1/me': () => fixtures.me(),
    'GET /api/v1/collections': () => ({ items, next_cursor: null }),
    'POST /api/v1/collections': async (request) => {
      const body = (await request.json()) as { name: string; description: string | null }
      const created = { ...items[0], ...body, id: 'nova', recording_count: 0 }
      items = [...items, created]
      return created
    },
    'PATCH /api/v1/collections/:id': async (request, { id }) => {
      const body = (await request.json()) as object
      items = items.map((c) => (c.id === id ? { ...c, ...body } : c))
      return items.find((c) => c.id === id)
    },
    'DELETE /api/v1/collections/:id': (_, { id }) => {
      items = items.filter((c) => c.id !== id)
      return empty()
    },
    'POST /api/v1/collections/:id/merge': async (request, { id }) => {
      const { into } = (await request.json()) as { into: string }
      const source = items.find((c) => c.id === id)!
      items = items
        .filter((c) => c.id !== id)
        .map((c) => (c.id === into ? { ...c, recording_count: c.recording_count + source.recording_count } : c))
      return items.find((c) => c.id === into)
    },
  })
}

describe('collections', () => {
  it('is opened from "Gerenciar coleções" in the library filter, with the DS header', async () => {
    mockCollections()
    mockFetch({
      'GET /api/v1/me': () => fixtures.me(),
      'GET /api/v1/recordings': () => fixtures.recordingWeekPage(),
      'GET /api/v1/tags': () => fixtures.tagList(),
      'GET /api/v1/collections': () => fixtures.collectionPage(),
      'GET /api/v1/fields': () => fixtures.fieldPage(),
      'GET /api/v1/people': () => fixtures.personPage(),
    })
    renderApp('/?visao=semana&data=2026-09-21')
    await userEvent.click(await screen.findByRole('link', { name: 'Gerenciar coleções' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Coleções' })).toBeInTheDocument()
    expect(screen.getByText('Organizar', { selector: '.kicker' })).toBeInTheDocument()
    expect(screen.getByText(/Coleção agrupa gravações; tag marca assuntos\. As duas convivem/)).toBeInTheDocument()
  })

  it('warns that collections also organize the desktop synced folder, with a link to help', async () => {
    mockCollections()
    renderApp('/colecoes')
    expect(await screen.findByRole('heading', { level: 1, name: 'Coleções' })).toBeInTheDocument()
    expect(screen.getByText(/as coleções também organizam a pasta sincronizada/)).toBeInTheDocument()
    expect(screen.getByText(/cada uma vira uma subpasta/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Saiba como funciona' })).toHaveAttribute('href', '/ajuda/pasta-sincronizada')
  })

  it('with no collections, teaches how to include by recording or by rule', async () => {
    mockCollections([])
    renderApp('/colecoes')
    const empty = await screen.findByText(/^Nenhuma coleção ainda\./)
    expect(empty).toHaveTextContent(
      'Crie uma com Nova coleção; as gravações entram pela página de cada gravação, em Coleções, ou sozinhas pela regra em Quando incluir.',
    )
  })

  it('lists with counts and leads to the collection recordings', async () => {
    mockCollections()
    renderApp('/colecoes')
    expect(await screen.findByRole('heading', { level: 1, name: 'Coleções' })).toBeInTheDocument()
    expect(screen.getByText('Organizar', { selector: '.kicker' })).toBeInTheDocument()
    const list = await screen.findByRole('list', { name: 'Coleções' })
    const row = within(list).getByText('Metalúrgica Serra Azul').closest('li')!
    expect(row).toHaveClass('list-row')
    expect(within(row).getByText('2 gravações')).toBeInTheDocument()
    expect(within(row).getByRole('link', { name: 'Ver gravações' })).toHaveAttribute('href', `/?colecao=${SERRA}`)
  })

  it('creates, renames and deletes in dialogs', async () => {
    const http = mockCollections()
    renderApp('/colecoes')
    await userEvent.click(await screen.findByRole('button', { name: 'Nova coleção' }))
    const createDialog = screen.getByRole('dialog', { name: 'Nova coleção' })
    await userEvent.type(within(createDialog).getByLabelText('Nome da coleção'), 'Programa de lideranças')
    await userEvent.click(within(createDialog).getByRole('button', { name: 'Criar coleção' }))
    const list = await screen.findByRole('list', { name: 'Coleções' })
    expect(await within(list).findByText('Programa de lideranças')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(await http.requests('POST /api/v1/collections')[0].json()).toEqual({
      name: 'Programa de lideranças',
      description: null,
      instructions: '',
      auto_assign: false,
    })

    await userEvent.click(screen.getByRole('button', { name: 'Editar Metalúrgica Serra Azul' }))
    const editDialog = screen.getByRole('dialog', { name: 'Editar coleção' })
    const nameField = within(editDialog).getByLabelText('Nome da coleção')
    await userEvent.clear(nameField)
    await userEvent.type(nameField, 'Serra Azul')
    await userEvent.click(within(editDialog).getByRole('button', { name: 'Salvar' }))
    expect(await within(list).findByText('Serra Azul')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Excluir Serra Azul' }))
    const deleteDialog = screen.getByRole('dialog', { name: 'Excluir Serra Azul?' })
    await userEvent.click(within(deleteDialog).getByRole('button', { name: 'Excluir coleção' }))
    await waitFor(() => expect(within(list).queryByText('Serra Azul')).not.toBeInTheDocument())
    expect(within(list).getByText('Programa de lideranças')).toBeInTheDocument()
  })

  it('the library filters by the collection in the URL', async () => {
    const http = mockFetch({
      'GET /api/v1/me': () => fixtures.me(),
      'GET /api/v1/collections': () => fixtures.collectionPage(),
      'GET /api/v1/recordings': () => fixtures.recordingPage(),
    })
    renderApp(`/?colecao=${SERRA}`)
    await waitFor(() => expect(http.requests('GET /api/v1/recordings').length).toBeGreaterThan(0))
    // The library's first query, after the shell's "does the account have any?" question (limit=1).
    const [query] = http
      .requests('GET /api/v1/recordings')
      .map((r) => new URL(r.url).searchParams)
      .filter((q) => q.get('limit') !== '1')
    expect(query.getAll('collection')).toEqual([SERRA])
  })

  it('creates an automatic collection with the rule, using an example', async () => {
    const http = mockCollections()
    renderApp('/colecoes')
    const list = await screen.findByRole('list', { name: 'Coleções' })
    expect(within(list).getByText('Automática')).toHaveClass('badge')
    await userEvent.click(screen.getByRole('button', { name: 'Nova coleção' }))
    const dialog = screen.getByRole('dialog', { name: 'Nova coleção' })
    await userEvent.type(within(dialog).getByLabelText('Nome da coleção'), 'Agro Sul')
    await userEvent.click(within(dialog).getByText('Exemplos de regras'))
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Usar o exemplo: Reuniões em que participa alguém da empresa Agro Sul.' }),
    )
    expect(within(dialog).getByLabelText('Quando incluir')).toHaveValue('Reuniões em que participa alguém da empresa Agro Sul.')
    await userEvent.click(within(dialog).getByRole('switch', { name: 'Incluir automaticamente depois da transcrição' }))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Criar coleção' }))
    await waitFor(() => expect(http.requests('POST /api/v1/collections')).toHaveLength(1))
    expect(await http.requests('POST /api/v1/collections')[0].json()).toEqual({
      name: 'Agro Sul',
      description: null,
      instructions: 'Reuniões em que participa alguém da empresa Agro Sul.',
      auto_assign: true,
    })
  })

  it('merges a collection into another one picked from the list', async () => {
    const [first] = fixtures.collectionPage().items
    const second = { ...first, id: 'clientes', name: 'Clientes', auto_assign: false, instructions: '' }
    const http = mockCollections([first, second])
    renderApp('/colecoes')
    await screen.findByRole('list', { name: 'Coleções' })
    await userEvent.click(screen.getByRole('button', { name: `Mesclar ${first.name} em outra coleção` }))
    const dialog = screen.getByRole('dialog', { name: `Mesclar ${first.name}` })
    expect(within(dialog).getByLabelText('Mesclar em')).toHaveValue(second.id)
    await userEvent.click(within(dialog).getByRole('button', { name: `Mesclar em ${second.name}` }))
    await waitFor(() => expect(http.requests('POST /api/v1/collections/:id/merge')).toHaveLength(1))
    expect(await http.requests('POST /api/v1/collections/:id/merge')[0].json()).toEqual({ into: second.id })
    await waitFor(() =>
      expect(within(screen.getByRole('list', { name: 'Coleções' })).queryByText(first.name)).not.toBeInTheDocument(),
    )
  })
})
