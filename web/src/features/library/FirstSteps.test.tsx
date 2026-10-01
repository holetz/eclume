import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { resetEnvironment } from '../../app/preferences'
import { fixtures } from '../../test/fixtures'
import { mockFetch } from '../../test/http'
import { renderApp } from '../../test/render'

const WEEK = '/?visao=semana&data=2026-09-21'
const NONE = { items: [], next_cursor: null }

afterEach(() => window.localStorage.clear())

function mockAccount({ recordings = true, people = true } = {}) {
  return mockFetch({
    'GET /api/v1/me': () => fixtures.me(),
    'GET /api/v1/recordings': () => (recordings ? fixtures.recordingWeekPage() : NONE),
    'GET /api/v1/tags': () => fixtures.tagList(),
    'GET /api/v1/collections': () => fixtures.collectionPage(),
    'GET /api/v1/fields': () => fixtures.fieldPage(),
    'GET /api/v1/people': () => (people ? fixtures.personPage() : NONE),
  })
}

async function card() {
  return screen.findByRole('region', { name: 'Primeiros passos' })
}

describe('Primeiros passos', () => {
  it('conta nova vê os três passos pendentes, com os caminhos da primeira gravação', async () => {
    mockAccount({ recordings: false, people: false })
    renderApp(WEEK)
    const steps = within(await card()).getAllByRole('listitem')
    expect(steps).toHaveLength(3)
    for (const step of steps) expect(step).not.toHaveAttribute('data-done')
    expect(within(steps[0]).getByRole('button', { name: 'Importe um arquivo' })).toBeInTheDocument()
    expect(within(steps[0]).getByRole('link', { name: 'app desktop' })).toHaveAttribute('href', '/app-desktop')
    expect(within(steps[0]).getByRole('link', { name: 'app do celular' })).toHaveAttribute('href', '/app-movel')
    expect(within(steps[1]).getByRole('link', { name: 'abrir Tipos de agenda' })).toHaveAttribute(
      'href',
      '/config/agendas',
    )
  })

  it('marca os passos cumpridos pelos dados da conta e pelo navegador', async () => {
    window.localStorage.setItem('eclume-tipos-de-agenda-visto', '1')
    mockAccount({ recordings: true, people: false })
    renderApp(WEEK)
    const steps = within(await card()).getAllByRole('listitem')
    expect(steps[0]).toHaveAttribute('data-done')
    expect(steps[0]).toHaveTextContent('(feito)')
    expect(steps[1]).toHaveAttribute('data-done')
    expect(steps[2]).not.toHaveAttribute('data-done')
  })

  it('some sozinho com os três passos feitos', async () => {
    window.localStorage.setItem('eclume-tipos-de-agenda-visto', '1')
    const http = mockAccount()
    renderApp(WEEK)
    await screen.findByText('21–27 de setembro de 2026')
    await waitFor(() => expect(http.requests('GET /api/v1/people').length).toBeGreaterThan(0))
    expect(screen.queryByRole('region', { name: 'Primeiros passos' })).toBeNull()
  })

  it('dispensar esconde o cartão neste navegador, e Restaurar os padrões o traz de volta', async () => {
    mockAccount({ recordings: false, people: false })
    const first = renderApp(WEEK)
    await userEvent.click(within(await card()).getByRole('button', { name: 'Dispensar' }))
    expect(screen.queryByRole('region', { name: 'Primeiros passos' })).toBeNull()
    expect(window.localStorage.getItem('eclume-primeiros-passos-dispensado')).toBe('1')
    first.unmount()

    renderApp(WEEK)
    await screen.findByRole('heading', { name: 'Nenhuma gravação ainda' })
    expect(screen.queryByRole('region', { name: 'Primeiros passos' })).toBeNull()

    resetEnvironment()
    expect(window.localStorage.getItem('eclume-primeiros-passos-dispensado')).toBeNull()
  })
})
