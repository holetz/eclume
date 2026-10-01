import { screen, within } from '@testing-library/react'
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
    ...overrides,
  })
}

const rows = () => within(screen.getByRole('list', { name: 'Etapas do processamento automático' })).getAllByRole('listitem')

describe('Processamento automático', () => {
  it('mostra as etapas na ordem do pipeline, com o estado de cada uma', async () => {
    mockAutomation()
    renderApp('/config/automacao')
    expect(await screen.findByRole('heading', { name: 'Processamento automático' })).toBeInTheDocument()
    expect(await screen.findByText('Voz: liga sozinho a partir de 75%')).toBeInTheDocument()
    expect(rows().map((row) => row.querySelector('.list-row-title')?.textContent)).toEqual([
      '1. Pré-processamento e transcrição',
      '2. Locutores pela voz',
      '3. Tipo de agenda',
      '4. Campos personalizados',
      '5. Tags',
      '6. Coleções com regra',
      '7. Resumo',
    ])
    expect(await screen.findByText('3 tipos de agenda')).toBeInTheDocument()
    // Título e Tags são campos de sistema: contam só os do usuário.
    expect(screen.getByText('2 campos preenchidos pelo agente')).toBeInTheDocument()
    expect(screen.getByText('Tags: só as cadastradas (12)')).toBeInTheDocument()
    expect(screen.getByText('1 coleção com regra')).toBeInTheDocument()
    expect(screen.getByText('3 tipos com instruções de resumo')).toBeInTheDocument()
  })

  it('leva a etapa à tela que a configura; a da plataforma não tem link', async () => {
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

  it('diz quando a chave está desligada e mostra o erro da etapa sem derrubar as outras', async () => {
    mockAutomation({
      'GET /api/v1/me/tag-assignment': () => ({ ...TAGS, mode: 'auto' }),
      'GET /api/v1/me/voice-assignment': () => ({ ...fixtures.voiceAssignment(), enabled: false }),
      'GET /api/v1/collections': () => problem('internal', 500),
    })
    renderApp('/config/automacao')
    expect(await screen.findByText('Tags: o agente pode criar tags')).toBeInTheDocument()
    expect(screen.getByText('Voz: só sugere, não liga sozinho')).toBeInTheDocument()
    expect(await within(rows()[5]).findByRole('alert')).toBeInTheDocument()
    expect(screen.getByText('3 tipos de agenda')).toBeInTheDocument()
  })
})
