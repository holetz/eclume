import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fixtures } from '../../test/fixtures'
import { json } from '../../test/http'
import { renderApp } from '../../test/render'
import { mockTranscriptApi, RECORDING_ID } from '../../test/transcriptApi'

afterEach(() => vi.unstubAllGlobals())

async function openPanel() {
  renderApp(`/gravacoes/${RECORDING_ID}`)
  return screen.findByRole('region', { name: 'Resumos' })
}

describe('resumos', () => {
  it('lista os resumos e abre o Markdown do pronto', async () => {
    mockTranscriptApi()
    const panel = await openPanel()
    const list = await within(panel).findByRole('list', { name: 'Resumos gerados' })
    expect(within(list).getByText('Pronto')).toBeInTheDocument()
    await userEvent.click(within(list).getByText('Reunião de equipe'))
    expect(await within(list).findByRole('heading', { name: /Ata — Alinhamento/ })).toBeInTheDocument()
  })

  it('gera com o primeiro tipo de agenda, mostra na fila e atualiza até ficar pronto', async () => {
    let polls = 0
    const http = mockTranscriptApi({
      'GET /api/v1/transcripts/:id/summaries': () => {
        polls++
        const queued = { ...fixtures.summaryQueued(), id: 'novo', version: 2 }
        const done = { ...fixtures.summaryDone(), id: 'novo', version: 2 }
        return { items: polls <= 1 ? [] : [polls > 2 ? done : queued], next_cursor: null }
      },
      'POST /api/v1/transcripts/:id/summaries': () =>
        json({ ...fixtures.summaryQueued(), id: 'novo', version: 2 }, 202),
    })
    const panel = await openPanel()
    expect(await within(panel).findByText('Nenhum resumo gerado ainda.')).toBeInTheDocument()
    const select = within(panel).getByLabelText('Tipo de agenda') as HTMLSelectElement
    await waitFor(() => expect(select.value).toBe('01928f3a-1c00-7a00-8000-000000000901'))
    await userEvent.click(within(panel).getByRole('button', { name: 'Gerar resumo' }))

    expect(await within(panel).findByText('Na fila')).toBeInTheDocument()
    expect(await within(panel).findByText('Pronto', {}, { timeout: 8000 })).toBeInTheDocument()
    const body = await http.requests('POST /api/v1/transcripts/:id/summaries')[0].json()
    expect(body).toEqual({ agenda_type_id: '01928f3a-1c00-7a00-8000-000000000901' })
  }, 15_000)

  it('gera com outro tipo de agenda escolhido', async () => {
    const http = mockTranscriptApi({
      'POST /api/v1/transcripts/:id/summaries': () => json(fixtures.summaryQueued(), 202),
    })
    const panel = await openPanel()
    const select = within(panel).getByLabelText('Tipo de agenda')
    await within(panel).findByRole('option', { name: '1:1' })
    await userEvent.selectOptions(select, '1:1')
    await userEvent.click(within(panel).getByRole('button', { name: 'Gerar resumo' }))
    await waitFor(() => expect(http.requests('POST /api/v1/transcripts/:id/summaries')).toHaveLength(1))
    const body = await http.requests('POST /api/v1/transcripts/:id/summaries')[0].json()
    expect(body).toEqual({ agenda_type_id: '01928f3a-1c00-7a00-8000-000000000902' })
  })
})
