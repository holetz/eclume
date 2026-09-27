import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fixtures } from '../../test/fixtures'
import { json } from '../../test/http'
import { renderApp } from '../../test/render'
import { mockTranscriptApi, RECORDING_ID as RECORDING } from '../../test/transcriptApi'

afterEach(() => vi.unstubAllGlobals())

const TAGS = '01928f3a-1c00-7a00-8000-000000000d02'
const CLIENT = '01928f3a-1c00-7a00-8000-000000000d03'

async function panel() {
  const section = await screen.findByRole('region', { name: 'Campos' })
  await within(section).findByRole('group', { name: 'Título' })
  return section
}

const prop = (section: HTMLElement, name: string) => within(section).getByRole('group', { name })

describe('painel de campos', () => {
  it('mostra cada valor com o selo de origem, o tipo, as coleções, os locutores e os dados antigos', async () => {
    mockTranscriptApi()
    renderApp(`/gravacoes/${RECORDING}`)
    const section = await panel()
    const labels = [...section.querySelectorAll('.prop-label')].map((label) => label.textContent)
    expect(labels).toEqual([
      'Título',
      'Tags',
      'Cliente',
      'Projeto',
      'Tipo de agenda',
      'Coleções',
      'Locutores',
      'Dados anteriores',
    ])

    const title = prop(section, 'Título')
    expect(title).toHaveTextContent('Revisão do contrato de manutenção')
    expect(title.querySelector('.origin')).toBeNull()
    expect(within(title).queryByRole('button', { name: 'Aceitar Título' })).not.toBeInTheDocument()

    const tags = prop(section, 'Tags')
    expect(within(tags).getByText('contrato')).toHaveClass('tag', 'tag-accent')
    expect(within(tags).getByText('Automático')).toHaveClass('origin')
    expect(within(tags).getByRole('button', { name: 'Aceitar Tags' })).toBeInTheDocument()

    expect(within(prop(section, 'Cliente')).getByText('Nada encontrado')).toHaveClass('text-muted')
    expect(within(prop(section, 'Projeto')).getByText('Editado')).toHaveClass('origin', 'origin-edited')

    const type = prop(section, 'Tipo de agenda')
    expect(type).toHaveTextContent('Reunião de equipeAutomático')
    expect(within(prop(section, 'Coleções')).getByText('Metalúrgica Serra Azul')).toHaveClass('tag-neutral')
    const speakers = prop(section, 'Locutores')
    expect(within(speakers).getByText('Mariana Couto')).toHaveClass('speaker', 'speaker-1')
    const legacy = prop(section, 'Dados anteriores')
    expect(legacy).toHaveTextContent('Cliente: Metalúrgica Serra Azul')
    expect(legacy).toHaveTextContent('Da organização antiga; crie um campo em Campos e regras para usar de novo.')
  })

  it('aceita um valor e aceita tudo', async () => {
    const user = userEvent.setup()
    const accepted = () => {
      const values = fixtures.recordingFieldValues()
      values.items = values.items.map((item) => ({
        ...item,
        origin: item.origin === 'auto' ? 'accepted' : item.origin,
      }))
      return values
    }
    const http = mockTranscriptApi({
      'POST /api/v1/recordings/:id/fields/:field/accept': () => accepted(),
      'POST /api/v1/recordings/:id/fields/accept': () => accepted(),
    })
    renderApp(`/gravacoes/${RECORDING}`)
    const section = await panel()
    await user.click(within(prop(section, 'Tags')).getByRole('button', { name: 'Aceitar Tags' }))
    await waitFor(() => expect(within(prop(section, 'Tags')).queryByText('Automático')).not.toBeInTheDocument())
    expect(http.requests('POST /api/v1/recordings/:id/fields/:field/accept')[0].url).toContain(`/fields/${TAGS}/accept`)
    expect(within(section).getByRole('button', { name: 'Aceitar tudo' })).toBeDisabled()
  })

  it('edita pelo tipo do campo: escolha, lista e texto, e relê a gravação quando é embutido', async () => {
    const user = userEvent.setup()
    const http = mockTranscriptApi({
      'PUT /api/v1/recordings/:id/fields/:field': () => fixtures.recordingFieldValues(),
    })
    renderApp(`/gravacoes/${RECORDING}`)
    const section = await panel()

    await user.click(within(prop(section, 'Cliente')).getByRole('button', { name: 'Editar Cliente' }))
    const select = within(prop(section, 'Cliente')).getByRole('combobox', { name: 'Cliente' })
    expect([...(select as HTMLSelectElement).options].map((option) => option.text)).toEqual([
      'Nenhum',
      'Serra Azul',
      'Vale Verde',
    ])
    await user.selectOptions(select, 'Serra Azul')
    await user.click(within(prop(section, 'Cliente')).getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(http.requests('PUT /api/v1/recordings/:id/fields/:field')).toHaveLength(1))
    const [first] = http.requests('PUT /api/v1/recordings/:id/fields/:field')
    expect(first.url).toContain(`/fields/${CLIENT}`)
    expect(await first.json()).toEqual({ value: 'Serra Azul' })

    const recordingReads = http.requests('GET /api/v1/recordings/:id').length
    await user.click(within(prop(section, 'Tags')).getByRole('button', { name: 'Editar Tags' }))
    const tags = within(prop(section, 'Tags')).getByRole('textbox', { name: 'Tags' })
    expect(tags).toHaveValue('contrato, manutenção')
    await user.type(tags, ', manutenção, prazo{Enter}')
    await waitFor(() => expect(http.requests('PUT /api/v1/recordings/:id/fields/:field')).toHaveLength(2))
    expect(await http.requests('PUT /api/v1/recordings/:id/fields/:field')[1].json()).toEqual({
      value: ['contrato', 'manutenção', 'prazo'],
    })
    await waitFor(() => expect(http.requests('GET /api/v1/recordings/:id').length).toBeGreaterThan(recordingReads))

    await user.click(within(prop(section, 'Título')).getByRole('button', { name: 'Editar Título' }))
    expect(within(prop(section, 'Título')).getByRole('textbox', { name: 'Título' })).toHaveAttribute('maxLength', '300')
    await user.keyboard('{Escape}')
    expect(within(prop(section, 'Título')).queryByRole('textbox')).not.toBeInTheDocument()
  }, 15_000)

  it('Trocar abre o diálogo do tipo de agenda', async () => {
    mockTranscriptApi()
    renderApp(`/gravacoes/${RECORDING}`)
    const section = await panel()
    await userEvent.click(
      within(prop(section, 'Tipo de agenda')).getByRole('button', { name: 'Trocar o tipo de agenda' }),
    )
    expect(screen.getByRole('dialog', { name: 'Trocar o tipo de agenda' })).toBeInTheDocument()
  })

  it('edita as coleções, com a criação de uma nova na hora', async () => {
    const user = userEvent.setup()
    const created = {
      ...fixtures.collectionPage().items[0],
      id: '01928f3a-1c00-7a00-8000-000000000802',
      name: 'Programa 2026',
    }
    const http = mockTranscriptApi({
      'POST /api/v1/collections': () => json(created, 201),
      'PATCH /api/v1/recordings/:id': async (request) => ({
        ...fixtures.recordingTranscribed(),
        ...((await request.json()) as object),
      }),
    })
    renderApp(`/gravacoes/${RECORDING}`)
    const section = await panel()
    await user.click(within(prop(section, 'Coleções')).getByRole('button', { name: 'Editar Coleções' }))
    const collections = prop(section, 'Coleções')
    expect(within(collections).getByRole('checkbox', { name: 'Metalúrgica Serra Azul' })).toBeChecked()
    await user.type(within(collections).getByRole('textbox', { name: 'Nova coleção' }), 'Programa 2026{Enter}')
    await waitFor(() => expect(http.requests('POST /api/v1/collections')).toHaveLength(1))
    await user.click(within(collections).getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(http.requests('PATCH /api/v1/recordings/:id')).toHaveLength(1))
    expect(await http.requests('PATCH /api/v1/recordings/:id')[0].json()).toEqual({
      collection_ids: ['01928f3a-1c00-7a00-8000-000000000801', created.id],
    })
  })

  it('"Corrigir locutores" abre a transcrição e leva o foco ao bloco Locutores', async () => {
    mockTranscriptApi()
    renderApp(`/gravacoes/${RECORDING}`)
    const section = await panel()
    expect(screen.queryByRole('region', { name: 'Locutores' })).not.toBeInTheDocument()
    await userEvent.click(within(prop(section, 'Locutores')).getByRole('button', { name: 'Corrigir locutores' }))
    const block = await screen.findByRole('region', { name: 'Locutores' })
    await waitFor(() => expect(block).toHaveFocus())
  })
})
