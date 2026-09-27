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
    const list = await screen.findByRole('list', { name: 'Coleções' })
    expect(within(list).getByRole('heading', { name: 'Metalúrgica Serra Azul' })).toBeInTheDocument()
    expect(within(list).getByText('2 gravações')).toBeInTheDocument()
    expect(within(list).getByRole('link', { name: 'Ver gravações' })).toHaveAttribute('href', `/?colecao=${SERRA}`)
  })

  it('cria, renomeia e exclui', async () => {
    const http = mockCollections()
    renderApp('/colecoes')
    await userEvent.click(await screen.findByRole('button', { name: 'Nova coleção' }))
    await userEvent.type(screen.getByLabelText('Nome da coleção'), 'Programa de lideranças')
    await userEvent.click(screen.getByRole('button', { name: 'Criar coleção' }))
    expect(await screen.findByRole('heading', { name: 'Programa de lideranças' })).toBeInTheDocument()
    expect(await http.requests('POST /api/v1/collections')[0].json()).toEqual({
      name: 'Programa de lideranças',
      description: null,
    })

    await userEvent.click(screen.getByRole('button', { name: 'Editar Metalúrgica Serra Azul' }))
    const nome = screen.getByLabelText('Nome da coleção')
    await userEvent.clear(nome)
    await userEvent.type(nome, 'Serra Azul')
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }))
    expect(await screen.findByRole('heading', { name: 'Serra Azul' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Excluir Serra Azul' }))
    await userEvent.click(screen.getByRole('button', { name: 'Confirmar exclusão' }))
    expect(await screen.findByRole('heading', { name: 'Programa de lideranças' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Serra Azul' })).not.toBeInTheDocument()
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
