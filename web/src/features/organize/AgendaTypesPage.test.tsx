import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Schemas } from '../../api/client'
import { fixtures } from '../../test/fixtures'
import { empty, mockFetch, problem } from '../../test/http'
import { preloadRoute, renderApp } from '../../test/render'

beforeAll(() => preloadRoute('/config/agendas'))

afterEach(() => vi.unstubAllGlobals())

const UM_A_UM = '01928f3a-1c00-7a00-8000-000000000902'
const EQUIPE = '01928f3a-1c00-7a00-8000-000000000901'

/** API de tipos de agenda com estado, como o servidor. */
function mockAgendaTypes(overrides: Record<string, Parameters<typeof mockFetch>[0][string]> = {}) {
  let items: Schemas['AgendaType'][] = [
    ...fixtures.agendaTypePage().items,
    {
      id: '01928f3a-1c00-7a00-8000-000000000903',
      name: 'Nota de voz',
      title_pattern: null,
      title_instructions: '',
      identify: 'Uma pessoa só, falando para si.',
      default_tags: [],
      summary_instructions: 'Reescreva o que foi dito como texto limpo, em parágrafos curtos, sem inventar nada que não foi dito.',
      position: 3,
      fallback: false,
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
        title_instructions: '',
        identify: '',
        default_tags: [],
        position: items.length + 1,
        fallback: false,
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
  it('abre o tipo padrão, no topo com o selo, sem Excluir e sem Como identificar', async () => {
    mockAgendaTypes()
    renderApp('/config/agendas')
    await list()
    const first = within(screen.getByRole('list', { name: 'Tipos de agenda' })).getAllByRole('listitem')[0]
    expect(within(first).getByRole('button', { name: /^Geral/ })).toHaveAttribute('aria-current', 'true')
    expect(within(first).getByText('Padrão')).toHaveClass('badge')
    const panel = screen.getByRole('form', { name: 'Editar Geral' })
    expect(within(panel).queryByRole('button', { name: 'Excluir tipo' })).not.toBeInTheDocument()
    expect(within(panel).queryByLabelText('Como identificar')).not.toBeInTheDocument()
    expect(within(panel).getByText(/nenhum outro tipo se encaixa com confiança/)).toBeInTheDocument()
    expect(within(panel).getByLabelText('Como escrever o assunto')).toHaveValue(
      'Um título curto, de até 8 palavras, que diga do que a conversa tratou. Sem data nem nomes de pessoas.',
    )
  })

  it('lista os tipos com o resumo das instruções e abre o escolhido no painel', async () => {
    mockAgendaTypes()
    renderApp(`/config/agendas?tipo=${EQUIPE}`)
    expect(await screen.findByRole('heading', { level: 1, name: 'Tipos de agenda' })).toBeInTheDocument()
    expect(screen.getByText('Organizar', { selector: '.kicker' })).toBeInTheDocument()
    await list()
    expect(within(row('Reunião de equipe')).getByText('Resumo: resumo, decisões, próximos passos')).toBeInTheDocument()
    expect(within(row('1:1')).getByText('Resumo: pontos tratados, combinados')).toBeInTheDocument()
    expect(
      within(row('Nota de voz')).getByText('Resumo: Reescreva o que foi dito como texto limpo, em parágrafos…'),
    ).toBeInTheDocument()
    expect(within(row('Reunião de equipe')).getByRole('button', { name: 'Reunião de equipe' })).toHaveAttribute('aria-current', 'true')

    const panel = screen.getByRole('form', { name: 'Editar Reunião de equipe' })
    expect(within(panel).getByRole('textbox', { name: /^Título da gravação/ })).toHaveValue('Reunião de equipe · {assunto}')
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
        '{projeto}',
      ]),
    )
    const title = within(panel).getByRole<HTMLInputElement>('textbox', { name: /^Título da gravação/ })
    await userEvent.type(title, '1:1 ·  · ')
    title.focus()
    title.setSelectionRange(6, 6)
    await userEvent.click(within(markers).getByRole('button', { name: 'Inserir {cliente}' }))
    // A inserção devolve o cursor no quadro seguinte: espera por ele antes de mover o cursor.
    await new Promise((resolve) => requestAnimationFrame(resolve))
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
      title_instructions: '',
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
      title_instructions: '',
      identify: '',
      default_tags: [],
      summary_instructions: '## Temas',
    })
    expect(within(row('Mentoria')).getByRole('button', { name: 'Mentoria' })).toHaveAttribute('aria-current', 'true')
  })

  it('pede para descartar as alterações antes de trocar de tipo', async () => {
    mockAgendaTypes()
    renderApp('/config/agendas')
    await list()
    await userEvent.type(screen.getByLabelText('Como escrever o assunto'), ' Sem siglas.')
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
    expect(dialog).toHaveTextContent('As gravações deste tipo passam para o tipo padrão. Os resumos já feitos continuam.')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Excluir tipo' }))
    await waitFor(() => expect(http.requests('DELETE /api/v1/agenda-types/:id')).toHaveLength(1))
    expect(await screen.findByRole('form', { name: 'Editar Geral' })).toBeInTheDocument()
    expect(within(screen.getByRole('list', { name: 'Tipos de agenda' })).queryByText('1:1')).not.toBeInTheDocument()
  })
})

describe('pré-visualizar numa gravação', () => {
  const RECORDING = '01928f3a-1c00-7a00-8000-000000000401'
  const queued = () => ({ ...fixtures.previewAgendaType(), status: 'queued', items: [] })
  const withRecordings = (extra: Record<string, Parameters<typeof mockFetch>[0][string]>) =>
    mockAgendaTypes({ 'GET /api/v1/recordings': () => fixtures.recordingPage(), ...extra })

  async function previewOn(panel: HTMLElement, recordingTitle: RegExp) {
    await userEvent.click(within(panel).getByRole('button', { name: 'Pré-visualizar numa gravação' }))
    const dialog = screen.getByRole('dialog', { name: 'Pré-visualizar numa gravação' })
    const select = await within(dialog).findByRole('combobox', { name: 'Gravação' })
    await userEvent.selectOptions(select, within(select).getByRole('option', { name: recordingTitle }))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Pré-visualizar' }))
  }

  it('roda o rascunho na gravação escolhida e mostra detecção, título, tags e resumo, sem salvar', async () => {
    const http = withRecordings({
      'POST /api/v1/agenda-types/preview': () => queued(),
      'GET /api/v1/previews/:id': () => fixtures.previewAgendaType(),
    })
    renderApp(`/config/agendas?tipo=${UM_A_UM}`)
    const panel = await screen.findByRole('form', { name: 'Editar 1:1' })
    await userEvent.type(within(panel).getByLabelText('Nome'), ' e mentoria')
    await previewOn(panel, /^Alinhamento do programa de lideranças · /)

    const recordings = new URL(http.requests('GET /api/v1/recordings')[0].url).searchParams
    expect(Object.fromEntries(recordings)).toEqual({ status: 'transcribed', sort: 'recorded_desc', limit: '20' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(within(panel).getByRole('status')).toHaveTextContent('Pré-visualizando na gravação…')
    const body = (await http.requests('POST /api/v1/agenda-types/preview')[0].json()) as Schemas['AgendaTypePreviewRequest']
    expect(body.recording_id).toBe(RECORDING)
    expect(body.agenda_type).toMatchObject({ name: '1:1 e mentoria', title_pattern: null, default_tags: [] })

    const result = await within(panel).findByRole('region', { name: 'Pré-visualização' }, { timeout: 5000 })
    expect(within(result).getByText('Este tipo seria escolhido (confiança 82%)')).toHaveClass('badge-success')
    expect(within(result).getByText('Mentoria · Próximos passos na carreira')).toBeInTheDocument()
    expect(within(within(result).getByRole('list', { name: 'Tags da pré-visualização' })).getByText('mentoria')).toBeInTheDocument()
    expect(within(result).getByRole('heading', { level: 2, name: 'Temas' })).toBeInTheDocument()
    expect(within(result).getByText('Ana revisa o plano até sexta.')).toBeInTheDocument()
    expect(http.requests('PATCH /api/v1/agenda-types/:id')).toHaveLength(0)
    expect(http.requests('POST /api/v1/agenda-types')).toHaveLength(0)
  })

  it('diz qual tipo o agente escolheria quando não é o rascunho, e some ao editar', async () => {
    const other = fixtures.previewAgendaType()
    other.items = [{ ...(other.items[0] as Schemas['AgendaTypePreviewItem']), detected: false, detected_type_name: 'Reunião de equipe', confidence: 0.64 }]
    withRecordings({ 'POST /api/v1/agenda-types/preview': () => other })
    renderApp(`/config/agendas?tipo=${UM_A_UM}`)
    const panel = await screen.findByRole('form', { name: 'Editar 1:1' })
    await previewOn(panel, /^Alinhamento/)

    const result = await within(panel).findByRole('region', { name: 'Pré-visualização' })
    const badge = within(result).getByText(/O agente escolheria/)
    expect(badge).toHaveClass('badge-warning')
    expect(badge).toHaveTextContent('O agente escolheria Reunião de equipe (confiança 64%)')
    expect(within(badge).getByText('Reunião de equipe').tagName).toBe('STRONG')

    await userEvent.type(within(panel).getByLabelText('Como identificar'), ' Semanal.')
    expect(within(panel).queryByRole('region', { name: 'Pré-visualização' })).not.toBeInTheDocument()
    expect(within(panel).getByRole('status')).toHaveTextContent('O rascunho mudou desde a pré-visualização.')
  })

  it('explica quando falta o agente e quando não há gravações transcritas', async () => {
    withRecordings({
      'POST /api/v1/agenda-types/preview': () => ({
        ...queued(),
        status: 'failed',
        error: { code: 'no_provider', message: 'Nenhum provider serve a finalidade summaries.' },
      }),
    })
    renderApp(`/config/agendas?tipo=${UM_A_UM}`)
    const panel = await screen.findByRole('form', { name: 'Editar 1:1' })
    await previewOn(panel, /^Alinhamento/)
    expect(await within(panel).findByRole('alert')).toHaveTextContent(
      'Nenhum agente está configurado para esta pré-visualização. Peça a quem administra o servidor.',
    )
  })

  it('sem gravações transcritas, o diálogo avisa e não deixa pré-visualizar', async () => {
    mockAgendaTypes({ 'GET /api/v1/recordings': () => ({ items: [], next_cursor: null }) })
    renderApp(`/config/agendas?tipo=${UM_A_UM}`)
    const panel = await screen.findByRole('form', { name: 'Editar 1:1' })
    await userEvent.click(within(panel).getByRole('button', { name: 'Pré-visualizar numa gravação' }))
    const dialog = screen.getByRole('dialog', { name: 'Pré-visualizar numa gravação' })
    expect(await within(dialog).findByText('Você ainda não tem gravações transcritas para pré-visualizar.')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Pré-visualizar' })).toBeDisabled()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
