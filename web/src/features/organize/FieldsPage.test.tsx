import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Schemas } from '../../api/client'
import { fixtures } from '../../test/fixtures'
import { empty, mockFetch, problem } from '../../test/http'
import { renderApp } from '../../test/render'

afterEach(() => vi.unstubAllGlobals())

const CLIENTE = '01928f3a-1c00-7a00-8000-000000000d03'

/** API de campos com estado, como o servidor. */
function mockFields(overrides: Record<string, Parameters<typeof mockFetch>[0][string]> = {}) {
  let items: Schemas['Field'][] = fixtures.fieldPage().items
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

describe('campos e regras', () => {
  it('lista os embutidos e os do usuário com o Automático, e abre o primeiro no painel', async () => {
    mockFields()
    renderApp('/config/campos')
    expect(await screen.findByRole('heading', { level: 1, name: 'Campos e regras' })).toBeInTheDocument()
    expect(screen.getByText('Organizar', { selector: '.kicker' })).toBeInTheDocument()
    await list()
    expect(within(row('Título')).getByText('Embutido · texto')).toBeInTheDocument()
    expect(within(row('Tags')).getByText('Embutido · lista')).toBeInTheDocument()
    expect(within(row('Cliente')).getByText('Seu campo · escolha')).toBeInTheDocument()
    expect(within(row('Cliente')).getByRole('checkbox', { name: 'Automático: Cliente' })).toBeChecked()
    expect(row('Título')).toHaveAttribute('aria-current', 'true')

    const panel = screen.getByRole('form', { name: 'Editar Título' })
    expect(within(panel).getByRole('radio', { name: 'Texto' })).toBeDisabled()
    expect(within(panel).getByText('O tipo de um campo embutido não muda.')).toBeInTheDocument()
    expect(within(panel).queryByRole('button', { name: 'Excluir campo' })).not.toBeInTheDocument()
    expect(within(panel).getByRole('button', { name: 'Sobre como escrever uma regra' })).toBeInTheDocument()
    expect(within(panel).getByRole('button', { name: 'Salvar' })).toBeDisabled()
  })

  it('o Automático grava na hora e volta atrás se o servidor recusar', async () => {
    const http = mockFields({
      'PATCH /api/v1/fields/:id': () => problem('forbidden', 403),
    })
    renderApp('/config/campos')
    await list()
    const toggle = within(row('Cliente')).getByRole('checkbox', { name: 'Automático: Cliente' })
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
    expect(row('Fase do projeto')).toHaveAttribute('aria-current', 'true')
  })

  it('pede para descartar as alterações antes de trocar de campo', async () => {
    mockFields()
    renderApp('/config/campos')
    await list()
    const panel = screen.getByRole('form', { name: 'Editar Título' })
    await userEvent.type(within(panel).getByLabelText('Como identificar'), ' Sem siglas.')
    await userEvent.click(within(row('Cliente')).getByRole('button', { name: 'Cliente' }))

    const dialog = screen.getByRole('dialog', { name: 'Descartar alterações?' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Continuar editando' }))
    expect(screen.getByRole('form', { name: 'Editar Título' })).toBeInTheDocument()
    expect(within(panel).getByLabelText('Como identificar')).toHaveValue(
      'Um título curto, de até 8 palavras, que diga do que a conversa tratou. Sem data nem nomes de pessoas. Sem siglas.',
    )

    await userEvent.click(within(row('Cliente')).getByRole('button', { name: 'Cliente' }))
    await userEvent.click(
      within(screen.getByRole('dialog', { name: 'Descartar alterações?' })).getByRole('button', { name: 'Descartar' }),
    )
    expect(await screen.findByRole('form', { name: 'Editar Cliente' })).toBeInTheDocument()
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
    await userEvent.type(name, 'Tags')
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
    expect(await screen.findByRole('form', { name: 'Editar Título' })).toBeInTheDocument()
  })
})
