import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Schemas } from '../../api/client'
import { fixtures } from '../../test/fixtures'
import { preloadRoute, renderApp } from '../../test/render'
import { mockTranscriptApi, RECORDING_ID as RECORDING } from '../../test/transcriptApi'

beforeAll(() => preloadRoute('/gravacoes/x'))

/** The transcribed recording stopped waiting for the names: speakers in `waiting`, the rest pending. */
function waitingRecording(): Schemas['Recording'] {
  const recording = fixtures.recordingTranscribed()
  recording.awaiting = 'speakers'
  recording.pipeline = recording.pipeline.map((step) => {
    if (step.step === 'speakers') return { ...step, state: 'waiting', reason: 'unnamed_speakers' }
    if (['agenda_type', 'fields', 'summary'].includes(step.step))
      return { ...step, state: 'pending', started_at: null, finished_at: null, duration_ms: null, reason: null }
    return step
  })
  return recording
}

describe('recording awaiting speakers', () => {
  it('shows the waiting step with the reason and the notice that leads to the speakers', async () => {
    mockTranscriptApi({ 'GET /api/v1/recordings/:id': () => waitingRecording() })
    renderApp(`/gravacoes/${RECORDING}`)
    const notice = await screen.findByRole('status', { name: 'Aguardando locutores' })
    expect(within(notice).getByRole('link', { name: 'Locutores' })).toHaveAttribute('href', '#locutores')
    const pipeline = screen.getByRole('list', { name: 'Processamento' })
    expect(within(pipeline).getByText('Locutores · aguardando você')).toHaveAttribute('data-state', 'waiting')
    expect(screen.getByRole('list', { name: 'Motivos das etapas' })).toHaveTextContent(/nomeie todos para seguir/)
  })

  it('Seguir sem nomear asks for confirmation and releases the recording', async () => {
    const user = userEvent.setup()
    const released = fixtures.recordingTranscribed()
    released.pipeline = released.pipeline.map((step) =>
      step.step === 'speakers' ? { ...step, state: 'skipped', reason: 'continued_by_user' } : step,
    )
    const http = mockTranscriptApi({
      'GET /api/v1/recordings/:id': () => waitingRecording(),
      'POST /api/v1/recordings/:id/continue': () => released,
    })
    renderApp(`/gravacoes/${RECORDING}`)
    await user.click(await screen.findByRole('button', { name: 'Seguir sem nomear' }))
    const dialog = await screen.findByRole('dialog', { name: 'Seguir sem nomear os locutores?' })
    await user.click(within(dialog).getByRole('button', { name: 'Seguir sem nomear' }))
    expect(http.requests('POST /api/v1/recordings/:id/continue')).toHaveLength(1)
    expect(await screen.findByText(/você seguiu sem nomear todos os locutores/)).toBeInTheDocument()
    expect(screen.queryByRole('status', { name: 'Aguardando locutores' })).not.toBeInTheDocument()
  })

  it('with no wait, no notice', async () => {
    mockTranscriptApi()
    renderApp(`/gravacoes/${RECORDING}`)
    await screen.findByRole('list', { name: 'Processamento' })
    expect(screen.queryByRole('status', { name: 'Aguardando locutores' })).not.toBeInTheDocument()
  })
})
