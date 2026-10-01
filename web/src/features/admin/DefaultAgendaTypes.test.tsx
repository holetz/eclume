import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Schemas } from '../../api/client'
import { fixtures } from '../../test/fixtures'
import { empty, json, mockFetch, problem } from '../../test/http'
import { preloadRoute, renderApp } from '../../test/render'
import { summaryOf } from './labels'

beforeAll(() => preloadRoute('/admin/tipos-de-agenda', '/admin/templates'))

afterEach(() => vi.unstubAllGlobals())

type AgendaType = Schemas['DefaultAgendaType']

function mockTypesApi(extra: Parameters<typeof mockFetch>[0] = {}) {
  return mockFetch({
    'GET /api/v1/admin/me': () => fixtures.adminMe(),
    'GET /api/v1/admin/default-agenda-types': () => fixtures.defaultAgendaTypePage(),
    // O server devolve o tipo com o que foi mandado.
    'PATCH /api/v1/admin/default-agenda-types/:id': async (request) => {
      const id = new URL(request.url).pathname.split('/').pop()
      const type = fixtures.defaultAgendaTypePage().items.find((item) => item.id === id)!
      return { ...type, ...(await request.json()) }
    },
    ...extra,
  })
}

const bodyOf = (http: ReturnType<typeof mockFetch>, key: string, index = 0) => http.requests(key)[index].json()
const row = (name: string) => screen.getByRole('button', { name }).closest('.list-row') as HTMLElement

describe('Tipos de agenda padrão', () => {
  it('resume as instruções pelos títulos ## ou pelo começo do texto', () => {
    expect(summaryOf('## A\nx\n## B\ny\n## C\n## D')).toBe('A, B, C')
    expect(summaryOf('Texto corrido sem títulos.')).toBe('Texto corrido sem títulos.')
    expect(summaryOf('a'.repeat(70))).toBe(`${'a'.repeat(60)}…`)
  })

  it('lista os tipos e abre o primeiro no painel', async () => {
    mockTypesApi()
    renderApp('/admin/tipos-de-agenda')
    const panel = await screen.findByRole('form', { name: 'Reunião de equipe' })
    expect(screen.getByRole('heading', { level: 1, name: 'Tipos de agenda padrão' })).toBeInTheDocument()
    expect(row('Reunião de equipe')).toHaveAttribute('aria-current', 'true')
    expect(within(row('Reunião de equipe')).getByText('Resumo: Resumo, Decisões, Próximos passos')).toBeInTheDocument()
    expect(within(row('1:1')).getByText('Resumo: Pontos tratados, Combinados')).toBeInTheDocument()
    expect(within(panel).getByLabelText('Nome')).toHaveValue('Reunião de equipe')
    expect(within(panel).getByLabelText('Título da gravação')).toHaveValue('Reunião de equipe · {assunto}')
    expect(within(panel).getByRole('button', { name: 'Remover interno' })).toBeInTheDocument()
    expect(within(panel).getByLabelText('Instruções do resumo')).toHaveValue(
      fixtures.defaultAgendaTypePage().items[0].summary_instructions,
    )
    expect(within(panel).getByRole('button', { name: 'Salvar' })).toBeDisabled()

    await userEvent.click(within(row('1:1')).getByText(/Pontos tratados/))
    expect(await screen.findByRole('form', { name: '1:1' })).toBeInTheDocument()
    expect(row('1:1')).toHaveAttribute('aria-current', 'true')
  })

  it('"Incluir para novos usuários" grava na hora e volta atrás no erro', async () => {
    const http = mockTypesApi()
    renderApp('/admin/tipos-de-agenda')
    const include = await screen.findByRole('switch', { name: 'Incluir 1:1 para novos usuários' })
    await userEvent.click(include)
    expect(include).not.toBeChecked()
    await vi.waitFor(() => expect(http.requests('PATCH /api/v1/admin/default-agenda-types/:id')).toHaveLength(1))
    expect(await bodyOf(http, 'PATCH /api/v1/admin/default-agenda-types/:id')).toEqual({ include_for_new_users: false })
    expect(include).not.toBeChecked()

    vi.unstubAllGlobals()
    mockTypesApi({ 'PATCH /api/v1/admin/default-agenda-types/:id': () => problem('forbidden', 403) })
    const team = screen.getByRole('switch', { name: 'Incluir Reunião de equipe para novos usuários' })
    await userEvent.click(team)
    expect(await screen.findByRole('alert')).toHaveTextContent('permissão')
    expect(team).toBeChecked()
  })

  it('edita só o que mudou, com tags em minúsculas e sem repetição', async () => {
    const http = mockTypesApi()
    renderApp('/admin/tipos-de-agenda')
    const panel = await screen.findByRole('form', { name: 'Reunião de equipe' })
    await userEvent.click(within(panel).getByRole('button', { name: 'Remover planejamento' }))
    const tag = within(panel).getByLabelText('Adicionar tag')
    await userEvent.type(tag, ' Semanal ,interno{Enter}')
    expect(within(panel).getByRole('button', { name: 'Remover semanal' })).toBeInTheDocument()
    await userEvent.clear(within(panel).getByLabelText('Como identificar'))
    await userEvent.type(within(panel).getByLabelText('Como identificar'), 'Reunião da equipe.')
    await userEvent.click(within(panel).getByRole('button', { name: 'Salvar' }))
    await vi.waitFor(() => expect(http.requests('PATCH /api/v1/admin/default-agenda-types/:id')).toHaveLength(1))
    expect(await bodyOf(http, 'PATCH /api/v1/admin/default-agenda-types/:id')).toEqual({
      identify: 'Reunião da equipe.',
      default_tags: ['interno', 'semanal'],
    })
    await vi.waitFor(() => expect(within(panel).getByRole('button', { name: 'Salvar' })).toBeDisabled())
  })

  it('cria um tipo novo e mostra o nome repetido no campo', async () => {
    const created: AgendaType = {
      ...fixtures.defaultAgendaTypePage().items[1],
      id: '01928f3a-1c00-7a00-8000-000000000c09',
      name: 'Nota de voz',
      position: 3,
    }
    let calls = 0
    const http = mockTypesApi({
      'POST /api/v1/admin/default-agenda-types': () =>
        ++calls === 1 ? problem('conflict', 409) : json(created, 201),
    })
    renderApp('/admin/tipos-de-agenda')
    await screen.findByRole('form', { name: 'Reunião de equipe' })
    await userEvent.click(screen.getByRole('button', { name: 'Novo tipo' }))
    const panel = screen.getByRole('form', { name: 'Novo tipo' })
    expect(within(panel).queryByRole('button', { name: 'Excluir tipo' })).not.toBeInTheDocument()
    await userEvent.type(within(panel).getByLabelText('Nome'), '1:1')
    await userEvent.type(within(panel).getByLabelText('Instruções do resumo'), 'Texto limpo.')
    await userEvent.click(within(panel).getByRole('button', { name: 'Salvar' }))
    expect(await within(panel).findByText('Já existe um tipo padrão com esse nome.')).toBeInTheDocument()
    expect(within(panel).getByLabelText('Nome')).toHaveAttribute('aria-invalid', 'true')

    await userEvent.clear(within(panel).getByLabelText('Nome'))
    await userEvent.type(within(panel).getByLabelText('Nome'), 'Nota de voz')
    await userEvent.click(within(panel).getByRole('button', { name: 'Salvar' }))
    expect(await screen.findByRole('form', { name: 'Nota de voz' })).toBeInTheDocument()
    expect(await bodyOf(http, 'POST /api/v1/admin/default-agenda-types', 1)).toEqual({
      name: 'Nota de voz',
      title_pattern: null,
      title_instructions: '',
      identify: '',
      default_tags: [],
      summary_instructions: 'Texto limpo.',
      include_for_new_users: true,
    })
    expect(row('Nota de voz')).toHaveAttribute('aria-current', 'true')
  })

  it('pede confirmação ao sair com mudanças e ao excluir', async () => {
    const http = mockTypesApi({ 'DELETE /api/v1/admin/default-agenda-types/:id': () => empty(204) })
    renderApp('/admin/tipos-de-agenda')
    const panel = await screen.findByRole('form', { name: 'Reunião de equipe' })
    await userEvent.type(within(panel).getByLabelText('Nome'), ' semanal')
    await userEvent.click(screen.getByRole('button', { name: '1:1' }))
    const discard = await screen.findByRole('dialog', { name: 'Descartar as mudanças em Reunião de equipe?' })
    await userEvent.click(within(discard).getByRole('button', { name: 'Cancelar' }))
    expect(screen.getByRole('form', { name: 'Reunião de equipe' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '1:1' }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Descartar' }))
    const other = await screen.findByRole('form', { name: '1:1' })

    await userEvent.click(within(other).getByRole('button', { name: 'Excluir tipo' }))
    const dialog = await screen.findByRole('dialog', { name: 'Excluir 1:1?' })
    expect(dialog).toHaveTextContent('As contas que já têm a cópia continuam com ela.')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Excluir tipo' }))
    await vi.waitFor(() => expect(screen.queryByRole('button', { name: '1:1' })).not.toBeInTheDocument())
    expect(new URL(http.requests('DELETE /api/v1/admin/default-agenda-types/:id')[0].url).pathname).toBe(
      '/api/v1/admin/default-agenda-types/01928f3a-1c00-7a00-8000-000000000c02',
    )
  })

  it('/admin/templates leva aos tipos de agenda padrão', async () => {
    mockTypesApi()
    renderApp('/admin/templates')
    expect(await screen.findByRole('heading', { level: 1, name: 'Tipos de agenda padrão' })).toBeInTheDocument()
  })
})
