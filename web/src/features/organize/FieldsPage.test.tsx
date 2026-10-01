import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Schemas } from '../../api/client'
import { fixtures } from '../../test/fixtures'
import { empty, mockFetch, problem } from '../../test/http'
import { preloadRoute, renderApp } from '../../test/render'

beforeAll(() => preloadRoute('/config/campos'))

afterEach(() => vi.unstubAllGlobals())

const CLIENTE = '01928f3a-1c00-7a00-8000-000000000d03'

/** API de campos com estado, como o servidor. */
function mockFields(
  overrides: Record<string, Parameters<typeof mockFetch>[0][string]> = {},
  initial: Schemas['Field'][] = fixtures.fieldPage().items,
) {
  let items = initial
  return mockFetch({
    'GET /api/v1/me': () => fixtures.me(),
    'GET /api/v1/fields': () => ({ items, next_cursor: null }),
    'POST /api/v1/fields': async (request) => {
      const body = (await request.json()) as Schemas['FieldCreate']
      const created: Schemas['Field'] = {
        id: 'novo-campo',
        key: 'projeto',
        builtin: null,
        options: [],
        instructions: '',
        auto_fill: true,
        position: items.length + 1,
        ...body,
      }
      items = [...items, created]
      return created
    },
    'PATCH /api/v1/fields/:id': async (request, { id }) => {
      const body = (await request.json()) as object
      items = items.map((f) => (f.id === id ? { ...f, ...body } : f))
      return items.find((f) => f.id === id)
    },
    'DELETE /api/v1/fields/:id': (_, { id }) => {
      items = items.filter((f) => f.id !== id)
      return empty()
    },
    ...overrides,
  })
}

const list = () => screen.findByRole('list', { name: 'Campos' })
const row = (name: string) => within(screen.getByRole('list', { name: 'Campos' })).getByRole('button', { name }).closest('li')!

describe('campos personalizados', () => {
  it('lista só os campos do usuário, com o Automático, e abre o primeiro no painel', async () => {
    mockFields()
    renderApp('/config/campos')
    expect(await screen.findByRole('heading', { level: 1, name: 'Campos personalizados' })).toBeInTheDocument()
    expect(screen.getByText('Organizar', { selector: '.kicker' })).toBeInTheDocument()
    await list()
    // O título vem dos tipos de agenda e as tags têm cadastro próprio: nenhum dos dois aparece aqui.
    const fields = within(screen.getByRole('list', { name: 'Campos' }))
    expect(fields.getAllByRole('listitem').map((li) => within(li).getByRole('button').textContent)).toEqual([
      'Cliente',
      'Projeto',
    ])
    expect(fields.queryByRole('button', { name: 'Título' })).toBeNull()
    expect(fields.queryByRole('button', { name: 'Tags' })).toBeNull()
    expect(screen.queryByText(/Embutido/)).not.toBeInTheDocument()
    const main = within(screen.getByRole('main'))
    expect(main.getByRole('link', { name: 'Tipos de agenda' })).toHaveAttribute('href', '/config/agendas')
    expect(main.getByRole('link', { name: 'Tags' })).toHaveAttribute('href', '/tags')
    expect(main.getByText(/As tags se configuram em/)).toBeInTheDocument()
    expect(within(row('Cliente')).getByText('Seu campo · escolha')).toBeInTheDocument()
    expect(within(row('Cliente')).getByRole('switch', { name: 'Automático: Cliente' })).toBeChecked()
    expect(within(row('Cliente')).getByRole('button', { name: 'Cliente' })).toHaveAttribute('aria-current', 'true')

    const panel = screen.getByRole('form', { name: 'Editar Cliente' })
    expect(within(panel).getByRole('radio', { name: 'Escolha' })).toBeChecked()
    expect(within(panel).getByRole('radio', { name: 'Lista' })).toBeEnabled()
    expect(within(panel).getByRole('button', { name: 'Excluir campo' })).toBeInTheDocument()
    expect(within(panel).getByRole('button', { name: 'Sobre como escrever uma regra' })).toBeInTheDocument()
    expect(within(panel).getByRole('button', { name: 'Salvar' })).toBeDisabled()
  })

  it('sem campos do usuário, o texto ocupa o lugar da lista e o painel só abre pelo Novo campo', async () => {
    const [title, tags] = fixtures.fieldPage().items
    mockFields({}, [title, tags])
    renderApp('/config/campos')
    expect(await screen.findByText(/^Nenhum campo personalizado ainda\. Crie um com Novo campo: por exemplo,/)).toHaveTextContent(
      'regra “A empresa cliente citada na reunião; vazio se nenhuma for citada”',
    )
    expect(screen.queryByRole('list', { name: 'Campos' })).not.toBeInTheDocument()
    expect(screen.queryByRole('form')).not.toBeInTheDocument()
    expect(screen.queryByText(/não existe mais/)).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Novo campo' }))
    expect(screen.getByRole('form', { name: 'Novo campo' })).toBeInTheDocument()
  })

  it('o endereço de um campo embutido (Tags) avisa que o campo não existe mais', async () => {
    mockFields()
    renderApp('/config/campos?campo=01928f3a-1c00-7a00-8000-000000000d02')
    expect(await screen.findByText('Este campo não existe mais. Escolha outro na lista.')).toBeInTheDocument()
    expect(screen.queryByRole('form')).not.toBeInTheDocument()
  })

  it('o Automático grava na hora e volta atrás se o servidor recusar', async () => {
    const http = mockFields({
      'PATCH /api/v1/fields/:id': () => problem('forbidden', 403),
    })
    renderApp('/config/campos')
    await list()
    const toggle = within(row('Cliente')).getByRole('switch', { name: 'Automático: Cliente' })
    await userEvent.click(toggle)
    expect(await http.requests('PATCH /api/v1/fields/:id')[0].json()).toEqual({ auto_fill: false })
    expect(await within(row('Cliente')).findByRole('alert')).toHaveTextContent('Não deu para mudar')
    await waitFor(() => expect(toggle).toBeChecked())
  })

  it('edita a regra de um campo de escolha e salva só o que o contrato pede', async () => {
    const http = mockFields()
    renderApp(`/config/campos?campo=${CLIENTE}`)
    const panel = await screen.findByRole('form', { name: 'Editar Cliente' })
    expect(within(panel).getByRole('radio', { name: 'Escolha' })).toBeChecked()
    const options = within(panel).getByRole('list', { name: 'Opções' })
    expect(within(options).getAllByRole('listitem').map((li) => li.firstChild?.textContent)).toEqual([
      'Serra Azul',
      'Vale Verde',
    ])
    await userEvent.type(within(panel).getByRole('textbox', { name: 'Opções' }), 'Guion{Enter}')
    await userEvent.click(within(panel).getByRole('button', { name: 'Remover opção Vale Verde' }))
    const rule = within(panel).getByLabelText('Como identificar')
    await userEvent.clear(rule)
    await userEvent.type(rule, 'Use o nome curto.')
    await userEvent.click(within(panel).getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(http.requests('PATCH /api/v1/fields/:id')).toHaveLength(1))
    expect(await http.requests('PATCH /api/v1/fields/:id')[0].json()).toEqual({
      name: 'Cliente',
      kind: 'choice',
      options: ['Serra Azul', 'Guion'],
      instructions: 'Use o nome curto.',
      auto_fill: true,
    })
    await waitFor(() => expect(within(panel).getByRole('button', { name: 'Salvar' })).toBeDisabled())
  })

  it('cria um campo novo pelo rascunho; Escolha exige uma opção', async () => {
    const http = mockFields()
    renderApp('/config/campos')
    await list()
    await userEvent.click(screen.getByRole('button', { name: 'Novo campo' }))
    const panel = screen.getByRole('form', { name: 'Novo campo' })
    expect(within(panel).queryByRole('button', { name: 'Excluir campo' })).not.toBeInTheDocument()
    await userEvent.type(within(panel).getByLabelText('Nome'), 'Fase do projeto')
    await userEvent.click(within(panel).getByRole('radio', { name: 'Escolha' }))
    expect(within(panel).getByRole('button', { name: 'Salvar' })).toBeDisabled()
    await userEvent.type(within(panel).getByRole('textbox', { name: 'Opções' }), 'Início{Enter}')
    await userEvent.click(within(panel).getByRole('button', { name: 'Salvar' }))

    expect(await screen.findByRole('form', { name: 'Editar Fase do projeto' })).toBeInTheDocument()
    expect(await http.requests('POST /api/v1/fields')[0].json()).toEqual({
      name: 'Fase do projeto',
      kind: 'choice',
      options: ['Início'],
      instructions: '',
      auto_fill: true,
    })
    expect(within(row('Fase do projeto')).getByRole('button', { name: 'Fase do projeto' })).toHaveAttribute('aria-current', 'true')
  })

  it('pede para descartar as alterações antes de trocar de campo', async () => {
    mockFields()
    renderApp('/config/campos')
    await list()
    const panel = screen.getByRole('form', { name: 'Editar Cliente' })
    await userEvent.type(within(panel).getByLabelText('Como identificar'), ' Sem siglas.')
    await userEvent.click(within(row('Projeto')).getByRole('button', { name: 'Projeto' }))

    const dialog = screen.getByRole('dialog', { name: 'Descartar alterações?' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Continuar editando' }))
    expect(screen.getByRole('form', { name: 'Editar Cliente' })).toBeInTheDocument()
    expect(within(panel).getByLabelText('Como identificar')).toHaveValue(
      'A empresa cliente de que a conversa trata; nenhuma, se for interna. Sem siglas.',
    )

    await userEvent.click(within(row('Projeto')).getByRole('button', { name: 'Projeto' }))
    await userEvent.click(
      within(screen.getByRole('dialog', { name: 'Descartar alterações?' })).getByRole('button', { name: 'Descartar' }),
    )
    expect(await screen.findByRole('form', { name: 'Editar Projeto' })).toBeInTheDocument()
  })

  it('pede para descartar as alterações antes de sair da rota', async () => {
    mockFields()
    renderApp('/config/campos')
    await list()
    const panel = screen.getByRole('form', { name: 'Editar Cliente' })
    await userEvent.type(within(panel).getByLabelText('Como identificar'), ' Sem siglas.')
    const nav = screen.getByRole('navigation', { name: 'Principal' })
    await userEvent.click(within(nav).getByRole('link', { name: 'Tags' }))

    const dialog = await screen.findByRole('dialog', { name: 'Descartar alterações?' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Continuar editando' }))
    expect(screen.getByRole('form', { name: 'Editar Cliente' })).toBeInTheDocument()
    expect(within(panel).getByLabelText('Como identificar')).toHaveValue(
      'A empresa cliente de que a conversa trata; nenhuma, se for interna. Sem siglas.',
    )
  })

  it('mostra o erro 422 no campo certo', async () => {
    mockFields({
      'PATCH /api/v1/fields/:id': () =>
        problem('validation_failed', 422, { errors: [{ field: 'name', message: 'já existe um campo com este nome' }] }),
    })
    renderApp(`/config/campos?campo=${CLIENTE}`)
    const panel = await screen.findByRole('form', { name: 'Editar Cliente' })
    const name = within(panel).getByLabelText('Nome')
    await userEvent.clear(name)
    await userEvent.type(name, 'Projeto')
    await userEvent.click(within(panel).getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(name).toHaveAttribute('aria-invalid', 'true'))
    expect(name).toHaveAccessibleDescription('já existe um campo com este nome')
  })

  it('exclui um campo do usuário depois de confirmar', async () => {
    const http = mockFields()
    renderApp(`/config/campos?campo=${CLIENTE}`)
    const panel = await screen.findByRole('form', { name: 'Editar Cliente' })
    await userEvent.click(within(panel).getByRole('button', { name: 'Excluir campo' }))
    const dialog = screen.getByRole('dialog', { name: 'Excluir Cliente?' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Excluir campo' }))
    await waitFor(() => expect(http.requests('DELETE /api/v1/fields/:id')).toHaveLength(1))
    await waitFor(() =>
      expect(within(screen.getByRole('list', { name: 'Campos' })).queryByText('Cliente')).not.toBeInTheDocument(),
    )
    expect(await screen.findByRole('form', { name: 'Editar Projeto' })).toBeInTheDocument()
  })
})

describe('testar numa gravação', () => {
  const queued = () => ({ ...fixtures.previewFieldRule(), status: 'queued', items: [] })

  it('roda o rascunho nas últimas gravações, mostra a espera e o valor de cada uma, sem salvar', async () => {
    const http = mockFields({
      'POST /api/v1/fields/preview': () => queued(),
      'GET /api/v1/previews/:id': () => fixtures.previewFieldRule(),
    })
    renderApp(`/config/campos?campo=${CLIENTE}`)
    const panel = await screen.findByRole('form', { name: 'Editar Cliente' })
    const rule = within(panel).getByLabelText('Como identificar')
    await userEvent.clear(rule)
    await userEvent.type(rule, 'Nome curto.')
    await userEvent.click(within(panel).getByRole('button', { name: 'Testar numa gravação' }))

    expect(within(panel).getByRole('status')).toHaveTextContent('Testando a regra nas últimas 3 gravações…')
    expect(within(panel).getByRole('button', { name: 'Testar numa gravação' })).toBeDisabled()
    expect(await http.requests('POST /api/v1/fields/preview')[0].json()).toEqual({
      field: {
        name: 'Cliente',
        kind: 'choice',
        options: ['Serra Azul', 'Vale Verde'],
        instructions: 'Nome curto.',
        auto_fill: true,
      },
    })

    const result = await within(panel).findByRole('list', { name: 'Resultado do teste' }, { timeout: 5000 })
    expect(within(panel).getByText('Nas últimas 2 gravações')).toBeInTheDocument()
    const [first, second] = within(result).getAllByRole('listitem')
    expect(first).toHaveTextContent('Revisão do contrato → Serra Azul')
    expect(within(first).getByText('Serra Azul').tagName).toBe('STRONG')
    expect(second).toHaveTextContent('Planejamento interno → vazio')
    expect(within(second).getByText('vazio').tagName).toBe('EM')
    expect(http.requests('PATCH /api/v1/fields/:id')).toHaveLength(0)
    expect(within(panel).getByRole('button', { name: 'Salvar' })).toBeEnabled()
  })

  it('explica quando nenhum agente preenche campos', async () => {
    mockFields({
      'POST /api/v1/fields/preview': () => ({
        ...queued(),
        status: 'failed',
        error: { code: 'no_provider', message: 'Nenhum provider serve a finalidade fields.' },
      }),
    })
    renderApp(`/config/campos?campo=${CLIENTE}`)
    const panel = await screen.findByRole('form', { name: 'Editar Cliente' })
    await userEvent.click(within(panel).getByRole('button', { name: 'Testar numa gravação' }))
    expect(await within(panel).findByRole('alert')).toHaveTextContent(
      'Nenhum agente está configurado para preencher campos. Peça a quem administra o servidor.',
    )
  })

  it('mostra a falha do agente e o erro da API', async () => {
    let calls = 0
    mockFields({
      'POST /api/v1/fields/preview': () =>
        ++calls === 1
          ? { ...queued(), status: 'failed', error: { code: 'provider_error', message: 'O agente não respondeu.' } }
          : problem('rate_limited', 429),
    })
    renderApp(`/config/campos?campo=${CLIENTE}`)
    const panel = await screen.findByRole('form', { name: 'Editar Cliente' })
    const button = within(panel).getByRole('button', { name: 'Testar numa gravação' })
    await userEvent.click(button)
    expect(await within(panel).findByRole('alert')).toHaveTextContent('O agente não respondeu.')
    await userEvent.click(button)
    expect(await within(panel).findByText('Muitas requisições seguidas. Aguarde um instante e tente de novo.')).toBeInTheDocument()
  })

  it('avisa quando ainda não há gravações transcritas', async () => {
    mockFields({ 'POST /api/v1/fields/preview': () => ({ ...queued(), status: 'done' }) })
    renderApp('/config/campos')
    const panel = await screen.findByRole('form', { name: 'Editar Cliente' })
    await userEvent.click(within(panel).getByRole('button', { name: 'Testar numa gravação' }))
    expect(await within(panel).findByRole('status')).toHaveTextContent(
      'Você ainda não tem gravações transcritas para testar.',
    )
  })
})
