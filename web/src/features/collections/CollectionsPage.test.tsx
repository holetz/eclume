import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Schemas } from '../../api/client'
import { fixtures } from '../../test/fixtures'
import { empty, mockFetch } from '../../test/http'
import { renderApp } from '../../test/render'
import { mockTranscriptApi, RECORDING_ID } from '../../test/transcriptApi'

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
    expect(await screen.findByText('Coleção: Metalúrgica Serra Azul')).toBeInTheDocument()
    const query = new URL(http.requests('GET /api/v1/recordings')[0].url).searchParams
    expect(query.get('collection')).toBe(SERRA)
    expect(screen.getByRole('link', { name: 'Limpar filtro' })).toHaveAttribute('href', '/')
  })
})

describe('organização da gravação', () => {
  it('o dono edita tags, coleções e metadados', async () => {
    const http = mockTranscriptApi({
      'PATCH /api/v1/recordings/:id': async (request) => ({
        ...fixtures.recordingTranscribed(),
        ...((await request.json()) as object),
        updated_at: '2026-09-20T10:00:00Z',
      }),
      'GET /api/v1/tags': () => fixtures.tagList(),
    })
    renderApp(`/gravacoes/${RECORDING_ID}`)
    const panel = await screen.findByRole('region', { name: 'Organização' })
    const tags = within(panel).getByLabelText('Tags')
    expect(tags).toHaveValue('programa-liderancas, cliente-metalurgica')
    await userEvent.clear(tags)
    await userEvent.type(tags, 'programa-liderancas, entrevista, entrevista')
    const cliente = within(panel).getByLabelText('Cliente')
    await userEvent.clear(cliente)
    const serra = await within(panel).findByRole('checkbox', { name: 'Metalúrgica Serra Azul' })
    await userEvent.click(serra)
    await userEvent.click(within(panel).getByRole('button', { name: 'Salvar organização' }))

    expect(await within(panel).findByText('Organização salva.')).toBeInTheDocument()
    const body = await http.requests('PATCH /api/v1/recordings/:id')[0].json()
    expect(body.tags).toEqual(['programa-liderancas', 'entrevista'])
    expect(body.metadata).toEqual({ tipo_reuniao: 'alinhamento', projeto: 'Programa de lideranças 2026' })
    expect(body.collection_ids).toEqual([])
  })

  it('quem vê por compartilhamento só lê', async () => {
    mockTranscriptApi({
      'GET /api/v1/recordings/:id': () => ({ ...fixtures.recordingTranscribed(), owner: { id: 'outro', name: 'Outro' } }),
    })
    renderApp(`/gravacoes/${RECORDING_ID}`)
    const panel = await screen.findByRole('region', { name: 'Organização' })
    expect(within(panel).getByText('Metalúrgica Serra Azul')).toBeInTheDocument()
    expect(within(panel).queryByRole('button')).not.toBeInTheDocument()
  })
})
