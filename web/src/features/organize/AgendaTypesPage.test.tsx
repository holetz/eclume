import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Schemas } from '../../api/client'
import { fixtures } from '../../test/fixtures'
import { empty, mockFetch, problem } from '../../test/http'
import { renderApp } from '../../test/render'

afterEach(() => vi.unstubAllGlobals())

const UM_A_UM = '01928f3a-1c00-7a00-8000-000000000902'

/** API de tipos de agenda com estado, como o servidor. */
function mockAgendaTypes(overrides: Record<string, Parameters<typeof mockFetch>[0][string]> = {}) {
  let items: Schemas['AgendaType'][] = [
    ...fixtures.agendaTypePage().items,
    {
      id: '01928f3a-1c00-7a00-8000-000000000903',
      name: 'Nota de voz',
      title_pattern: null,
      identify: 'Uma pessoa só, falando para si.',
      default_tags: [],
      summary_instructions: 'Reescreva o que foi dito como texto limpo, em parágrafos curtos, sem inventar nada que não foi dito.',
      position: 3,
    },
  ]
  return mockFetch({
    'GET /api/v1/me': () => fixtures.me(),
    'GET /api/v1/fields': () => fixtures.fieldPage(),
    'GET /api/v1/agenda-types': () => ({ items, next_cursor: null }),
    'POST /api/v1/agenda-types': async (request) => {
      const body = (await request.json()) as Schemas['AgendaTypeCreate']
      const created: Schemas['AgendaType'] = {
        id: 'novo-tipo',
        title_pattern: null,
        identify: '',
        default_tags: [],
        position: items.length + 1,
        ...body,
      }
      items = [...items, created]
      return created
    },
    'PATCH /api/v1/agenda-types/:id': async (request, { id }) => {
      const body = (await request.json()) as object
      items = items.map((t) => (t.id === id ? { ...t, ...body } : t))
      return items.find((t) => t.id === id)
    },
    'DELETE /api/v1/agenda-types/:id': (_, { id }) => {
      items = items.filter((t) => t.id !== id)
      return empty()
    },
    ...overrides,
  })
}

const list = () => screen.findByRole('list', { name: 'Tipos de agenda' })
const row = (name: string) =>
  within(screen.getByRole('list', { name: 'Tipos de agenda' })).getByRole('button', { name }).closest('li')!

describe('tipos de agenda', () => {
  it('lista os tipos com o resumo das instruções e abre o primeiro no painel', async () => {
    mockAgendaTypes()
    renderApp('/config/agendas')
    expect(await screen.findByRole('heading', { level: 1, name: 'Tipos de agenda' })).toBeInTheDocument()
    expect(screen.getByText('Organizar', { selector: '.kicker' })).toBeInTheDocument()
    await list()
    expect(within(row('Reunião de equipe')).getByText('Resumo: resumo, decisões, próximos passos')).toBeInTheDocument()
    expect(within(row('1:1')).getByText('Resumo: pontos tratados, combinados')).toBeInTheDocument()
    expect(
      within(row('Nota de voz')).getByText('Resumo: Reescreva o que foi dito como texto limpo, em parágrafos cur'),
    ).toBeInTheDocument()
    expect(row('Reunião de equipe')).toHaveAttribute('aria-current', 'true')

    const panel = screen.getByRole('form', { name: 'Editar Reunião de equipe' })
    expect(within(panel).getByRole('textbox', { name: /^Título da gravação/ })).toHaveValue('Reunião de equipe · {assunto}')
    expect(within(panel).getByText('· substitui a regra do título em Campos e regras')).toBeInTheDocument()
    expect(within(panel).getByLabelText('Como identificar')).toHaveAccessibleDescription(
      'Depois da transcrição, um agente lê isto e escolhe o tipo.',
    )
    const tags = within(panel).getByRole('list', { name: 'Tags padrão' })
    expect(within(tags).getAllByRole('listitem').map((li) => li.firstChild?.textContent)).toEqual(['interno', 'planejamento'])
    expect(within(panel).getByLabelText('Instruções do resumo')).toHaveAccessibleDescription(
      'Em Markdown. O resumo segue estas instruções.',
    )
    expect(within(panel).getByRole('button', { name: 'Sobre como montar o título' })).toBeInTheDocument()
  })

  it('oferece os marcadores, com as chaves dos campos do usuário, e os insere no cursor', async () => {
    const http = mockAgendaTypes()
    renderApp(`/config/agendas?tipo=${UM_A_UM}`)
    const panel = await screen.findByRole('form', { name: 'Editar 1:1' })
    const markers = within(panel).getByRole('group', { name: 'Marcadores do título' })
    await waitFor(() =>
      expect(within(markers).getAllByRole('button').map((b) => b.textContent)).toEqual([
        '{assunto}',
        '{data}',
        '{tipo}',
        '{cliente}',
      ]),
    )
    const title = within(panel).getByRole<HTMLInputElement>('textbox', { name: /^Título da gravação/ })
    await userEvent.type(title, '1:1 ·  · ')
    title.focus()
    title.setSelectionRange(6, 6)
    await userEvent.click(within(markers).getByRole('button', { name: 'Inserir {cliente}' }))
    await userEvent.click(title)
    title.setSelectionRange(title.value.length, title.value.length)
    await userEvent.click(within(markers).getByRole('button', { name: 'Inserir {data}' }))
    expect(title).toHaveValue('1:1 · {cliente} · {data}')

    await userEvent.type(within(panel).getByRole('textbox', { name: 'Tags padrão' }), 'equipe{Enter}')
    await userEvent.click(within(panel).getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(http.requests('PATCH /api/v1/agenda-types/:id')).toHaveLength(1))
    expect(await http.requests('PATCH /api/v1/agenda-types/:id')[0].json()).toEqual({
      name: '1:1',
      title_pattern: '1:1 · {cliente} · {data}',
      identify: 'Conversa entre duas pessoas da mesma equipe sobre andamento, dificuldades e desenvolvimento.',
      default_tags: ['equipe'],
      summary_instructions:
        '## Pontos tratados\nUm item por assunto, em uma ou duas frases.\n\n## Combinados\nUm item por acompanhamento combinado: quem, o quê e até quando.',
    })
  })

  it('cria um tipo novo; o padrão vazio vai como null', async () => {
    const http = mockAgendaTypes()
    renderApp('/config/agendas')
    await list()
    await userEvent.click(screen.getByRole('button', { name: 'Novo tipo' }))
    const panel = screen.getByRole('form', { name: 'Novo tipo' })
    expect(within(panel).queryByRole('button', { name: 'Excluir tipo' })).not.toBeInTheDocument()
    await userEvent.type(within(panel).getByLabelText('Nome'), 'Mentoria')
    expect(within(panel).getByRole('button', { name: 'Salvar' })).toBeDisabled()
    await userEvent.type(within(panel).getByLabelText('Instruções do resumo'), '## Temas')
    await userEvent.click(within(panel).getByRole('button', { name: 'Salvar' }))

    expect(await screen.findByRole('form', { name: 'Editar Mentoria' })).toBeInTheDocument()
    expect(await http.requests('POST /api/v1/agenda-types')[0].json()).toEqual({
      name: 'Mentoria',
      title_pattern: null,
      identify: '',
      default_tags: [],
      summary_instructions: '## Temas',
    })
    expect(row('Mentoria')).toHaveAttribute('aria-current', 'true')
  })

  it('pede para descartar as alterações antes de trocar de tipo', async () => {
    mockAgendaTypes()
    renderApp('/config/agendas')
    await list()
    await userEvent.type(screen.getByLabelText('Como identificar'), ' Semanal.')
    await userEvent.click(within(row('1:1')).getByRole('button', { name: '1:1' }))
    await userEvent.click(
      within(screen.getByRole('dialog', { name: 'Descartar alterações?' })).getByRole('button', { name: 'Descartar' }),
    )
    expect(await screen.findByRole('form', { name: 'Editar 1:1' })).toBeInTheDocument()
  })

  it('mostra o nome repetido no campo', async () => {
    mockAgendaTypes({
      'PATCH /api/v1/agenda-types/:id': () =>
        problem('validation_failed', 422, { errors: [{ field: 'name', message: 'já existe um tipo com este nome' }] }),
    })
    renderApp(`/config/agendas?tipo=${UM_A_UM}`)
    const panel = await screen.findByRole('form', { name: 'Editar 1:1' })
    const name = within(panel).getByLabelText('Nome')
    await userEvent.type(name, ' semanal')
    await userEvent.click(within(panel).getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(name).toHaveAttribute('aria-invalid', 'true'))
    expect(name).toHaveAccessibleDescription('já existe um tipo com este nome')
  })

  it('exclui um tipo avisando o que acontece com as gravações', async () => {
    const http = mockAgendaTypes()
    renderApp(`/config/agendas?tipo=${UM_A_UM}`)
    const panel = await screen.findByRole('form', { name: 'Editar 1:1' })
    await userEvent.click(within(panel).getByRole('button', { name: 'Excluir tipo' }))
    const dialog = screen.getByRole('dialog', { name: 'Excluir 1:1?' })
    expect(dialog).toHaveTextContent('As gravações deste tipo ficam sem tipo. Os resumos já feitos continuam.')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Excluir tipo' }))
    await waitFor(() => expect(http.requests('DELETE /api/v1/agenda-types/:id')).toHaveLength(1))
    expect(await screen.findByRole('form', { name: 'Editar Reunião de equipe' })).toBeInTheDocument()
    expect(within(screen.getByRole('list', { name: 'Tipos de agenda' })).queryByText('1:1')).not.toBeInTheDocument()
  })
})
