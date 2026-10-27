import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { fixtures } from '../../test/fixtures'
import { empty, mockFetch } from '../../test/http'
import { preloadRoute, renderApp } from '../../test/render'

beforeAll(() => preloadRoute('/pessoas/x'))

afterEach(() => vi.unstubAllGlobals())

const RAFAEL = '01928f3a-1c00-7a00-8000-000000000302'

function mockPerson(extra: Parameters<typeof mockFetch>[0] = {}) {
  return mockFetch({
    'GET /api/v1/me': () => fixtures.me(),
    'GET /api/v1/people/:id': () => fixtures.person(),
    'GET /api/v1/people/:id/transcripts': () => fixtures.transcriptPage(),
    'GET /api/v1/people/:id/voiceprint': () => fixtures.voiceprint(),
    'GET /api/v1/search': () => fixtures.searchPage(),
    ...extra,
  })
}

const stat = (label: string) => screen.getByText(label, { selector: '.stat .kicker' }).closest('.stat') as HTMLElement

describe('person page', () => {
  it('shows the header and the numbers: recordings, speaking time and voice samples', async () => {
    mockPerson()
    renderApp(`/pessoas/${RAFAEL}`)
    expect(await screen.findByRole('heading', { level: 1, name: 'Rafael Lima' })).toBeInTheDocument()
    expect(screen.getByText('Pessoa', { selector: '.kicker' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '← Pessoas' })).toHaveAttribute('href', '/pessoas')
    expect(screen.getByText('Gerente de RH da Metalúrgica Serra Azul.')).toBeInTheDocument()
    expect(within(stat('Gravações')).getByText('3')).toBeInTheDocument()
    expect(await within(stat('Amostras de voz')).findByText('2')).toBeInTheDocument()
    expect(within(stat('Amostras de voz')).getByText('Suficiente para sugerir')).toBeInTheDocument()
    expect(within(stat('Tempo de fala')).getByText('7 min 29 s')).toBeInTheDocument()
  })

  it('says when voice identification is off or has no samples', async () => {
    mockPerson({
      'GET /api/v1/people/:id/voiceprint': () => ({ ...fixtures.voiceprint(), enabled: false, sample_count: 0, samples: [] }),
    })
    renderApp(`/pessoas/${RAFAEL}`)
    expect(await screen.findByText('Desligada neste servidor')).toHaveClass('stat-sub')
    expect(within(stat('Amostras de voz')).getByText('0')).toBeInTheDocument()
  })

  it('switches tabs by click and by arrow keys, and keeps the tab in ?aba=', async () => {
    const http = mockPerson()
    renderApp(`/pessoas/${RAFAEL}`)
    const tabs = await screen.findByRole('tablist', { name: 'Sobre a pessoa' })
    const recordingsTab = within(tabs).getByRole('tab', { name: 'Gravações' })
    expect(recordingsTab).toHaveAttribute('aria-selected', 'true')
    const list = await screen.findByRole('list', { name: 'Gravações da pessoa' })
    expect(within(list).getAllByRole('link')[0]).toHaveAttribute('href', expect.stringMatching(/^\/gravacoes\//))

    await userEvent.click(within(tabs).getByRole('tab', { name: 'Falas' }))
    const utterances = await screen.findByRole('list', { name: 'Falas da pessoa' })
    expect(within(utterances).getAllByRole('listitem')).toHaveLength(3)
    expect(within(utterances).getByRole('link', { name: /02:02/ })).toHaveAttribute(
      'href',
      '/gravacoes/01928f3a-1c00-7a00-8000-000000000401?t=122500',
    )
    expect(new URL(http.requests('GET /api/v1/search')[0].url).searchParams.get('person')).toBe(RAFAEL)

    await userEvent.keyboard('{ArrowRight}')
    const samplesTab = within(tabs).getByRole('tab', { name: 'Amostras de voz' })
    expect(samplesTab).toHaveAttribute('aria-selected', 'true')
    expect(samplesTab).toHaveFocus()
    expect(await screen.findByRole('list', { name: 'Amostras de voz' })).toBeInTheDocument()
    await userEvent.keyboard('{ArrowRight}')
    expect(recordingsTab).toHaveFocus()
  })

  it('opens straight on the ?aba= tab', async () => {
    mockPerson()
    renderApp(`/pessoas/${RAFAEL}?aba=falas`)
    expect(await screen.findByRole('tab', { name: 'Falas' })).toHaveAttribute('aria-selected', 'true')
    expect(await screen.findByRole('list', { name: 'Falas da pessoa' })).toBeInTheDocument()
  })

  it('edits in the dialog', async () => {
    let current = fixtures.person()
    const http = mockPerson({
      'GET /api/v1/people/:id': () => current,
      'PATCH /api/v1/people/:id': async (request) => (current = { ...current, ...((await request.json()) as object) }),
    })
    renderApp(`/pessoas/${RAFAEL}`)
    await userEvent.click(await screen.findByRole('button', { name: 'Editar' }))
    const dialog = screen.getByRole('dialog', { name: 'Editar pessoa' })
    const name = within(dialog).getByLabelText('Nome')
    await userEvent.clear(name)
    await userEvent.type(name, 'Rafael Lima Souza')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Rafael Lima Souza' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(await http.requests('PATCH /api/v1/people/:id')[0].json()).toMatchObject({ name: 'Rafael Lima Souza' })
  })

  it('shows and edits the record: company, department, role and person tags', async () => {
    let current = fixtures.person()
    const http = mockPerson({
      'GET /api/v1/people/:id': () => current,
      'GET /api/v1/people/facets': () => ({ companies: [{ value: 'Agro Sul', count: 2 }], departments: [], tags: [] }),
      'PATCH /api/v1/people/:id': async (request) => (current = { ...current, ...((await request.json()) as object) }),
    })
    renderApp(`/pessoas/${RAFAEL}`)
    expect(await screen.findByText('Gerente de RH · Recursos Humanos · Metalúrgica Serra Azul')).toBeInTheDocument()
    expect(within(screen.getByRole('list', { name: 'Tags da pessoa' })).getByText('cliente')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Editar' }))
    const dialog = screen.getByRole('dialog', { name: 'Editar pessoa' })
    const company = within(dialog).getByLabelText('Empresa')
    expect(company).toHaveValue('Metalúrgica Serra Azul')
    await userEvent.clear(company)
    await userEvent.type(company, 'Agro Sul')
    await userEvent.clear(within(dialog).getByLabelText('Área'))
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Tags da pessoa' }), 'diretoria{Enter}')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(http.requests('PATCH /api/v1/people/:id')).toHaveLength(1))
    expect(await http.requests('PATCH /api/v1/people/:id')[0].json()).toMatchObject({
      company: 'Agro Sul',
      department: null,
      job_title: 'Gerente de RH',
      tags: ['cliente', 'diretoria'],
    })
  })

  it('deletes through the edit dialog, with confirmation', async () => {
    const http = mockPerson({
      'DELETE /api/v1/people/:id': () => empty(),
      'GET /api/v1/people': () => fixtures.personPage(),
    })
    renderApp(`/pessoas/${RAFAEL}`)
    await userEvent.click(await screen.findByRole('button', { name: 'Editar' }))
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Excluir pessoa' }))
    const confirm = screen.getByRole('dialog', { name: 'Excluir Rafael Lima?' })
    expect(confirm).toHaveTextContent('Excluir desfaz os vínculos com os locutores e apaga a impressão de voz. As transcrições ficam.')
    await userEvent.click(within(confirm).getByRole('button', { name: 'Excluir pessoa' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Pessoas' })).toBeInTheDocument()
    expect(http.requests('DELETE /api/v1/people/:id')).toHaveLength(1)
  })
})
