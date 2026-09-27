import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Schemas } from '../../api/client'
import { fixtures } from '../../test/fixtures'
import { empty, mockFetch } from '../../test/http'
import { renderApp } from '../../test/render'

afterEach(() => vi.unstubAllGlobals())

const SERRA = '01928f3a-1c00-7a00-8000-000000000801'

/** API de coleções com estado, como o servidor. */
function mockCollections() {
  let items: Schemas['Collection'][] = fixtures.collectionPage().items
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
  })
}

describe('coleções', () => {
  it('é aberta por "Gerenciar coleções" no filtro da biblioteca, com o cabeçalho do DS', async () => {
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

  it('lista com contagem e leva às gravações da coleção', async () => {
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

  it('cria, renomeia e exclui em diálogos', async () => {
    const http = mockCollections()
    renderApp('/colecoes')
    await userEvent.click(await screen.findByRole('button', { name: 'Nova coleção' }))
    const nova = screen.getByRole('dialog', { name: 'Nova coleção' })
    await userEvent.type(within(nova).getByLabelText('Nome da coleção'), 'Programa de lideranças')
    await userEvent.click(within(nova).getByRole('button', { name: 'Criar coleção' }))
    const list = await screen.findByRole('list', { name: 'Coleções' })
    expect(await within(list).findByText('Programa de lideranças')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(await http.requests('POST /api/v1/collections')[0].json()).toEqual({
      name: 'Programa de lideranças',
      description: null,
    })

    await userEvent.click(screen.getByRole('button', { name: 'Editar Metalúrgica Serra Azul' }))
    const editar = screen.getByRole('dialog', { name: 'Editar coleção' })
    const nome = within(editar).getByLabelText('Nome da coleção')
    await userEvent.clear(nome)
    await userEvent.type(nome, 'Serra Azul')
    await userEvent.click(within(editar).getByRole('button', { name: 'Salvar' }))
    expect(await within(list).findByText('Serra Azul')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Excluir Serra Azul' }))
    const excluir = screen.getByRole('dialog', { name: 'Excluir Serra Azul?' })
    await userEvent.click(within(excluir).getByRole('button', { name: 'Excluir coleção' }))
    await waitFor(() => expect(within(list).queryByText('Serra Azul')).not.toBeInTheDocument())
    expect(within(list).getByText('Programa de lideranças')).toBeInTheDocument()
  })

  it('a biblioteca filtra pela coleção da URL', async () => {
    const http = mockFetch({
      'GET /api/v1/me': () => fixtures.me(),
      'GET /api/v1/collections': () => fixtures.collectionPage(),
      'GET /api/v1/recordings': () => fixtures.recordingPage(),
    })
    renderApp(`/?colecao=${SERRA}`)
    await waitFor(() => expect(http.requests('GET /api/v1/recordings').length).toBeGreaterThan(0))
    const query = new URL(http.requests('GET /api/v1/recordings')[0].url).searchParams
    expect(query.getAll('collection')).toEqual([SERRA])
  })
})
