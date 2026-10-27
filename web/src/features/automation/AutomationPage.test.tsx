import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Schemas } from '../../api/client'
import { fixtures } from '../../test/fixtures'
import { mockFetch, problem } from '../../test/http'
import { preloadRoute, renderApp } from '../../test/render'

beforeAll(() => preloadRoute('/config/automacao'))

afterEach(() => vi.unstubAllGlobals())

const TAGS: Schemas['TagAssignment'] = {
  auto_fill: true,
  instructions: '',
  mode: 'fixed',
  new_limit: 1,
  catalog_count: 12,
  catalog_limit: 200,
}

function mockAutomation(overrides: Record<string, Parameters<typeof mockFetch>[0][string]> = {}) {
  return mockFetch({
    'GET /api/v1/me': () => fixtures.me(),
    'GET /api/v1/me/voice-assignment': () => ({ ...fixtures.voiceAssignment(), threshold: 0.75 }),
    'GET /api/v1/agenda-types': () => fixtures.agendaTypePage(),
    'GET /api/v1/fields': () => fixtures.fieldPage(),
    'GET /api/v1/me/tag-assignment': () => TAGS,
    'GET /api/v1/collections': () => fixtures.collectionPage(),
    'GET /api/v1/me/speaker-naming': () => ({ required: false, waiting_count: 0 }),
    ...overrides,
  })
}

const rows = () => within(screen.getByRole('list', { name: 'Etapas do processamento automático' })).getAllByRole('listitem')

describe('Automatic processing', () => {
  it('shows the steps in pipeline order, with the state of each', async () => {
    mockAutomation()
    renderApp('/config/automacao')
    expect(await screen.findByRole('heading', { name: 'Processamento automático' })).toBeInTheDocument()
    expect(await screen.findByText('Voz: liga sozinho a partir de 75%')).toBeInTheDocument()
    expect(rows().map((row) => row.querySelector('.list-row-title')?.textContent)).toEqual([
      '1. Pré-processamento e transcrição',
      '2. Locutores pela voz',
      '3. Marcação dos locutores',
      '4. Tipo de agenda',
      '5. Campos personalizados',
      '6. Tags',
      '7. Coleções com regra',
      '8. Resumo',
    ])
    expect(await screen.findByText('3 tipos de agenda')).toBeInTheDocument()
    // Título and Tags are system fields: only the user's ones count.
    expect(screen.getByText('2 campos preenchidos pelo agente')).toBeInTheDocument()
    expect(screen.getByText('Tags: só as cadastradas (12)')).toBeInTheDocument()
    expect(screen.getByText('1 coleção com regra')).toBeInTheDocument()
    expect(screen.getByText('3 tipos com instruções de resumo')).toBeInTheDocument()
  })

  it('links each step to the screen that configures it; the platform one has no link', async () => {
    mockAutomation()
    renderApp('/config/automacao')
    await screen.findByText('Voz: liga sozinho a partir de 75%')
    const [platform, voice] = rows()
    expect(within(platform).queryByRole('link')).not.toBeInTheDocument()
    expect(within(platform).getByText('Da plataforma')).toBeInTheDocument()
    expect(within(voice).getByRole('link', { name: 'Configurar em Pessoas' })).toHaveAttribute('href', '/pessoas')
    expect(screen.getByRole('link', { name: 'Configurar em Tags' })).toHaveAttribute('href', '/tags')
    expect(screen.getByRole('link', { name: 'Configurar em Coleções' })).toHaveAttribute('href', '/colecoes')
    expect(screen.getByRole('link', { name: 'Configurar em Campos personalizados' })).toHaveAttribute(
      'href',
      '/config/campos',
    )
  })

  it('says when the switch is off and shows the step error without bringing the others down', async () => {
    mockAutomation({
      'GET /api/v1/me/tag-assignment': () => ({ ...TAGS, mode: 'auto' }),
      'GET /api/v1/me/voice-assignment': () => ({ ...fixtures.voiceAssignment(), enabled: false }),
      'GET /api/v1/collections': () => problem('internal', 500),
    })
    renderApp('/config/automacao')
    expect(await screen.findByText('Tags: o agente pode criar tags')).toBeInTheDocument()
    expect(screen.getByText('Voz: só sugere, não liga sozinho')).toBeInTheDocument()
    expect(await within(rows()[6]).findByRole('alert')).toBeInTheDocument()
    expect(screen.getByText('3 tipos de agenda')).toBeInTheDocument()
  })

  it('switches on mandatory speaker labelling right here and shows how many recordings are waiting', async () => {
    const http = mockAutomation({
      'PATCH /api/v1/me/speaker-naming': () => ({ required: true, waiting_count: 0 }),
    })
    renderApp('/config/automacao')
    expect(await screen.findByText('Não exigida: a gravação segue com "Locutor N"')).toBeInTheDocument()
    const toggle = screen.getByRole('switch', { name: 'Exigir a marcação dos locutores' })
    expect(toggle).not.toBeChecked()
    await userEvent.click(toggle)
    expect(await screen.findByText('Exigida')).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Exigir a marcação dos locutores' })).toBeChecked()
    expect(await http.requests('PATCH /api/v1/me/speaker-naming')[0].json()).toEqual({ required: true })
  })

  it('with labelling required, counts the recordings waiting for you', async () => {
    mockAutomation({ 'GET /api/v1/me/speaker-naming': () => ({ required: true, waiting_count: 2 }) })
    renderApp('/config/automacao')
    expect(await screen.findByText('Exigida · 2 gravações esperando você')).toBeInTheDocument()
  })
})
