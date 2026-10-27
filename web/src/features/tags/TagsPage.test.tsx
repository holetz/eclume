import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Schemas } from '../../api/client'
import { fixtures } from '../../test/fixtures'
import { empty, json, mockFetch, problem } from '../../test/http'
import { preloadRoute, renderApp } from '../../test/render'

beforeAll(() => preloadRoute('/tags'))

afterEach(() => vi.unstubAllGlobals())

type Tag = Schemas['Tag']
type Assignment = Schemas['TagAssignment']

const CLIENT = '01928f3a-1c00-7a00-8000-000000000b01'
const LEADERSHIP = '01928f3a-1c00-7a00-8000-000000000b02'

const ASSIGNMENT: Assignment = {
  auto_fill: true,
  instructions: 'De 1 a 5 tags curtas, em minúsculas. Prefira as tags que você já usa.',
  mode: 'fixed',
  new_limit: 1,
  catalog_count: 2,
  catalog_limit: 200,
}

/** Stateful tags API, like the server: the same name (case-insensitive) is 409, and the registry comes in order. */
function mockTags(
  initial: Tag[] = fixtures.tagList().items,
  start: Assignment = ASSIGNMENT,
  overrides: Record<string, Parameters<typeof mockFetch>[0][string]> = {},
) {
  let items = initial
  let config = start
  const sorted = (list: Tag[]) => [...list].sort((a, b) => a.name.localeCompare(b.name))
  const taken = (name: string, except?: string) =>
    items.some((tag) => tag.id !== except && tag.name.toLowerCase() === name.toLowerCase())
  const assignment = () => ({ ...config, catalog_count: items.length })
  return mockFetch({
    'GET /api/v1/me': () => fixtures.me(),
    'GET /api/v1/tags': () => ({ items }),
    'GET /api/v1/me/tag-assignment': () => assignment(),
    'PATCH /api/v1/me/tag-assignment': async (request) => {
      config = { ...config, ...((await request.json()) as Partial<Assignment>) }
      return assignment()
    },
    'POST /api/v1/tags': async (request) => {
      const body = (await request.json()) as { name: string; description?: string }
      if (taken(body.name)) return problem('tag_exists', 409)
      const created: Tag = { id: 'nova', description: '', ...body, origin: 'user', count: 0, created_at: '2026-09-30T12:00:00Z' }
      items = sorted([...items, created])
      return json(created, 201)
    },
    'PATCH /api/v1/tags/:id': async (request, { id }) => {
      const body = (await request.json()) as Partial<Tag>
      if (body.name && taken(body.name, id)) return problem('tag_exists', 409)
      items = sorted(items.map((tag) => (tag.id === id ? { ...tag, ...body } : tag)))
      return items.find((tag) => tag.id === id)
    },
    'DELETE /api/v1/tags/:id': (_, { id }) => {
      items = items.filter((tag) => tag.id !== id)
      return empty()
    },
    'POST /api/v1/tags/:id/merge': async (request, { id }) => {
      const { into } = (await request.json()) as { into: string }
      const source = items.find((tag) => tag.id === id)!
      items = items
        .filter((tag) => tag.id !== id)
        .map((tag) => (tag.id === into ? { ...tag, count: tag.count + source.count } : tag))
      return items.find((tag) => tag.id === into)
    },
    ...overrides,
  })
}

const card = () => screen.findByRole('region', { name: 'Atribuição automática de tags' })
const list = () => screen.findByRole('list', { name: 'Tags' })
const rowOf = (name: string) => within(screen.getByRole('list', { name: 'Tags' })).getByText(name).closest('li')!

describe('tags: the screen', () => {
  it('opens from the Organizar menu, with the DS header and the text', async () => {
    mockTags()
    renderApp('/tags')
    expect(await screen.findByRole('heading', { level: 1, name: 'Tags' })).toBeInTheDocument()
    expect(screen.getByText('Organizar', { selector: '.kicker' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Nova tag' })).toBeInTheDocument()
    expect(screen.getByText(/o agente só usa as tags cadastradas aqui/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Saiba como funciona' })).toHaveAttribute('href', '/ajuda/tags-cadastradas')
    const nav = screen.getByRole('navigation', { name: 'Principal' })
    expect(within(nav).getByRole('link', { name: 'Tags' })).toHaveAttribute('aria-current', 'page')
  })

  it('lists with the badge, the description, the count and the link to the recordings', async () => {
    const [cliente, liderancas] = fixtures.tagList().items
    mockTags([cliente, liderancas, { ...cliente, id: 'reuniao', name: 'reunião semanal', description: '', count: 3 }])
    renderApp('/tags')
    const tags = await list()
    expect(within(tags).getAllByRole('listitem')).toHaveLength(3)

    const first = rowOf('cliente-metalurgica')
    expect(first).toHaveClass('list-row')
    expect(within(first).getByText('Conversas com a Metalúrgica Serra Azul ou sobre ela.')).toBeInTheDocument()
    expect(within(first).getByText('1 gravação')).toBeInTheDocument()
    expect(within(first).queryByText('Criada pelo agente')).not.toBeInTheDocument()
    expect(within(first).getByRole('link', { name: 'Ver gravações' })).toHaveAttribute('href', '/?tag=cliente-metalurgica')

    expect(within(rowOf('programa-liderancas')).getByText('Criada pelo agente')).toHaveClass('badge')
    const third = rowOf('reunião semanal')
    expect(within(third).getByText('3 gravações')).toBeInTheDocument()
    expect(within(third).getByRole('link', { name: 'Ver gravações' })).toHaveAttribute('href', '/?tag=reuni%C3%A3o%20semanal')
  })

  it('with no tags, explains how to start', async () => {
    mockTags([])
    renderApp('/tags')
    expect(await screen.findByText(/Nenhuma tag ainda\. Crie uma com Nova tag/)).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Tags' })).not.toBeInTheDocument()
  })
})

describe('tags: the agent configuration', () => {
  it('shows the configuration and saves the switch at once', async () => {
    const http = mockTags()
    renderApp('/tags')
    const region = await card()
    const toggle = within(region).getByRole('switch', { name: 'Atribuir tags automaticamente depois da transcrição' })
    expect(toggle).toBeChecked()
    expect(within(region).getByLabelText('Regra geral')).toHaveValue(ASSIGNMENT.instructions)
    await userEvent.click(toggle)
    await waitFor(() => expect(toggle).not.toBeChecked())
    expect(await http.requests('PATCH /api/v1/me/tag-assignment')[0].json()).toEqual({ auto_fill: false })
  })

  it('saves the general rule only through Salvar, with what changed', async () => {
    const http = mockTags()
    renderApp('/tags')
    const region = await card()
    const save = within(region).getByRole('button', { name: 'Salvar' })
    expect(save).toBeDisabled()
    const rule = within(region).getByLabelText('Regra geral')
    await userEvent.clear(rule)
    await userEvent.type(rule, 'Use no máximo 3 tags.')
    expect(http.requests('PATCH /api/v1/me/tag-assignment')).toHaveLength(0)
    await userEvent.click(save)
    await waitFor(() => expect(http.requests('PATCH /api/v1/me/tag-assignment')).toHaveLength(1))
    expect(await http.requests('PATCH /api/v1/me/tag-assignment')[0].json()).toEqual({ instructions: 'Use no máximo 3 tags.' })
    await waitFor(() => expect(save).toBeDisabled())
    expect(rule).toHaveValue('Use no máximo 3 tags.')
  })

  it('chooses the mode at once and, with the agent creating, the limit per recording', async () => {
    const http = mockTags()
    renderApp('/tags')
    const region = await card()
    expect(within(region).getByRole('radio', { name: 'Só as tags cadastradas' })).toBeChecked()
    expect(within(region).queryByLabelText('Tags novas por gravação')).not.toBeInTheDocument()

    await userEvent.click(within(region).getByRole('radio', { name: 'O agente pode criar tags' }))
    expect(await http.requests('PATCH /api/v1/me/tag-assignment')[0].json()).toEqual({ mode: 'auto' })
    const limit = await within(region).findByLabelText('Tags novas por gravação')
    expect(limit).toHaveValue('1')
    expect(within(limit).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Até 1 tag nova',
      'Até 2 tags novas',
      'Até 3 tags novas',
      'Até 4 tags novas',
      'Até 5 tags novas',
    ])
    expect(
      within(region).getByText(
        /O agente sempre prefere reusar uma tag cadastrada e casa variações \(maiúsculas, acentos, plural\)\. Ele para de criar tags quando o cadastro chega a 200\./,
      ),
    ).toBeInTheDocument()
    expect(within(region).getByText('2 de 200 tags')).toBeInTheDocument()

    await userEvent.selectOptions(limit, '3')
    await waitFor(() => expect(http.requests('PATCH /api/v1/me/tag-assignment')).toHaveLength(2))
    expect(await http.requests('PATCH /api/v1/me/tag-assignment')[1].json()).toEqual({ new_limit: 3 })
    await waitFor(() => expect(limit).toHaveValue('3'))

    await userEvent.click(within(region).getByRole('radio', { name: 'Só as tags cadastradas' }))
    await waitFor(() => expect(within(region).queryByLabelText('Tags novas por gravação')).not.toBeInTheDocument())
    expect(await http.requests('PATCH /api/v1/me/tag-assignment')[2].json()).toEqual({ mode: 'fixed' })
  })

  it('shows the error when the server refuses the change', async () => {
    mockTags(undefined, undefined, { 'PATCH /api/v1/me/tag-assignment': () => problem('forbidden', 403) })
    renderApp('/tags')
    const region = await card()
    await userEvent.click(within(region).getByRole('radio', { name: 'O agente pode criar tags' }))
    expect(await within(region).findByRole('alert')).toHaveTextContent('Você não tem permissão para esta ação.')
    expect(within(region).getByRole('radio', { name: 'Só as tags cadastradas' })).toBeChecked()
  })
})

describe('tags: new, edit, merge and delete', () => {
  it('creates a tag with the description; the duplicate name shows the way out through merging', async () => {
    const http = mockTags()
    renderApp('/tags')
    await userEvent.click(await screen.findByRole('button', { name: 'Nova tag' }))
    const dialog = screen.getByRole('dialog', { name: 'Nova tag' })
    await userEvent.type(within(dialog).getByLabelText('Nome da tag'), 'Cliente-Metalurgica')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Criar tag' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Já existe uma tag com esse nome. Para juntar as duas, use Mesclar.',
    )
    expect(screen.getByRole('dialog', { name: 'Nova tag' })).toBeInTheDocument()

    const name = within(dialog).getByLabelText('Nome da tag')
    await userEvent.clear(name)
    await userEvent.type(name, 'orçamento')
    await userEvent.type(within(dialog).getByLabelText('Quando usar'), 'Conversas sobre custos e propostas.')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Criar tag' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    const row = await waitFor(() => rowOf('orçamento'))
    expect(within(row).getByText('Conversas sobre custos e propostas.')).toBeInTheDocument()
    expect(within(row).getByText('0 gravações')).toBeInTheDocument()
    expect(await http.requests('POST /api/v1/tags')[1].json()).toEqual({
      name: 'orçamento',
      description: 'Conversas sobre custos e propostas.',
    })
  })

  it('renames sending only what changed, and the duplicate name is refused', async () => {
    const http = mockTags()
    renderApp('/tags')
    await list()
    await userEvent.click(screen.getByRole('button', { name: 'Editar cliente-metalurgica' }))
    const dialog = screen.getByRole('dialog', { name: 'Editar tag' })
    expect(within(dialog).getByLabelText('Quando usar')).toHaveValue('Conversas com a Metalúrgica Serra Azul ou sobre ela.')
    const save = within(dialog).getByRole('button', { name: 'Salvar' })
    expect(save).toBeDisabled()

    const name = within(dialog).getByLabelText('Nome da tag')
    await userEvent.clear(name)
    await userEvent.type(name, 'Programa-Liderancas')
    await userEvent.click(save)
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Já existe uma tag com esse nome. Para juntar as duas, use Mesclar.')

    await userEvent.clear(name)
    await userEvent.type(name, 'serra-azul')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(await within(await list()).findByText('serra-azul')).toBeInTheDocument()
    expect(within(screen.getByRole('list', { name: 'Tags' })).queryByText('cliente-metalurgica')).not.toBeInTheDocument()
    const patches = http.requests('PATCH /api/v1/tags/:id')
    expect(patches).toHaveLength(2)
    expect(new URL(patches[1].url).pathname).toBe(`/api/v1/tags/${CLIENT}`)
    expect(await patches[1].json()).toEqual({ name: 'serra-azul' })
  })

  it('changes only the description without touching the name', async () => {
    const http = mockTags()
    renderApp('/tags')
    await list()
    await userEvent.click(screen.getByRole('button', { name: 'Editar programa-liderancas' }))
    const dialog = screen.getByRole('dialog', { name: 'Editar tag' })
    await userEvent.type(within(dialog).getByLabelText('Quando usar'), 'Mentoria e desenvolvimento de líderes.')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }))
    expect(await within(rowOf('programa-liderancas')).findByText('Mentoria e desenvolvimento de líderes.')).toBeInTheDocument()
    expect(await http.requests('PATCH /api/v1/tags/:id')[0].json()).toEqual({
      description: 'Mentoria e desenvolvimento de líderes.',
    })
  })

  it('merges a tag into another chosen one, and with a single tag does not offer merging', async () => {
    const http = mockTags()
    renderApp('/tags')
    await list()
    await userEvent.click(screen.getByRole('button', { name: 'Mesclar cliente-metalurgica em outra tag' }))
    const dialog = screen.getByRole('dialog', { name: 'Mesclar cliente-metalurgica' })
    expect(within(dialog).getByText(/Onde havia cliente-metalurgica, passa a haver a tag escolhida, nas gravações e nas tags padrão dos tipos de agenda\./)).toBeInTheDocument()
    expect(within(dialog).getByText(/cliente-metalurgica sai do cadastro/)).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Mesclar em')).toHaveValue(LEADERSHIP)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Mesclar em programa-liderancas' }))
    await waitFor(() => expect(http.requests('POST /api/v1/tags/:id/merge')).toHaveLength(1))
    expect(await http.requests('POST /api/v1/tags/:id/merge')[0].json()).toEqual({ into: LEADERSHIP })
    await waitFor(() => expect(screen.queryByText('cliente-metalurgica')).not.toBeInTheDocument())
    expect(within(rowOf('programa-liderancas')).getByText('2 gravações')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Mesclar .* em outra tag/ })).not.toBeInTheDocument()
  })

  it('deletes after confirming, warning what goes away', async () => {
    const http = mockTags()
    renderApp('/tags')
    await list()
    await userEvent.click(screen.getByRole('button', { name: 'Excluir programa-liderancas' }))
    const dialog = screen.getByRole('dialog', { name: 'Excluir programa-liderancas?' })
    expect(dialog).toHaveTextContent('A tag sai do cadastro, de todas as gravações e das tags padrão dos tipos de agenda.')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Excluir tag' }))
    await waitFor(() => expect(http.requests('DELETE /api/v1/tags/:id')).toHaveLength(1))
    expect(new URL(http.requests('DELETE /api/v1/tags/:id')[0].url).pathname).toBe(`/api/v1/tags/${LEADERSHIP}`)
    await waitFor(() => expect(screen.queryByText('programa-liderancas')).not.toBeInTheDocument())
    expect(screen.getByText('cliente-metalurgica')).toBeInTheDocument()
  })

  it('Manter closes the delete dialog without deleting', async () => {
    const http = mockTags()
    renderApp('/tags')
    await list()
    await userEvent.click(screen.getByRole('button', { name: 'Excluir cliente-metalurgica' }))
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Manter' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(http.requests('DELETE /api/v1/tags/:id')).toHaveLength(0)
  })
})
