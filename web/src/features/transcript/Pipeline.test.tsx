import { render, screen } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import type { Schemas } from '../../api/client'
import { createQueryClient } from '../../app/queryClient'
import { fixtures } from '../../test/fixtures'
import { Pipeline } from './Pipeline'

type Queue = NonNullable<Schemas['Job']['queue']>

const IN_12_MIN = () => new Date(Date.now() + 12 * 60_000 + 20_000).toISOString()

function waiting(queue: Partial<Queue> | null) {
  const recording = fixtures.recordingQueued()
  recording.job = {
    ...recording.job!,
    queue:
      queue === null
        ? null
        : {
            reason: 'processor_queue',
            ahead: null,
            account_ahead: null,
            estimated_start_at: null,
            resumes_at: null,
            processor: { online: true, offline_since: null },
            ...queue,
          },
  }
  render(
    <QueryClientProvider client={createQueryClient({ retry: false })}>
      <Pipeline recording={recording} />
    </QueryClientProvider>,
  )
  return screen.getByRole('status')
}

describe('the wait in the queue', () => {
  it('shows the position and the forecast labelled as an estimate', () => {
    expect(waiting({ ahead: 2, estimated_start_at: IN_12_MIN() })).toHaveTextContent(
      '3ª na fila · começa em cerca de 12 min (estimativa)',
    )
  })

  it('with no history, only the position', () => {
    expect(waiting({ ahead: 0 })).toHaveTextContent(/^1ª na fila$/)
  })

  it('behind the account\'s own recordings', () => {
    expect(waiting({ reason: 'account_turn', account_ahead: 2 })).toHaveTextContent(
      'Atrás de 2 gravações suas que chegaram antes.',
    )
  })

  it('in the minutes window, says when it frees up', () => {
    const at = new Date()
    at.setHours(23, 59, 0, 0)
    expect(waiting({ reason: 'quota_window', resumes_at: at.toISOString() })).toHaveTextContent(
      'Seus minutos de transcrição das últimas 24 h acabaram; a gravação entra às 23:59.',
    )
  })

  it('with the processor down, says since when and that the recording is stored', () => {
    const since = new Date()
    since.setHours(0, 2, 0, 0)
    const status = waiting({ ahead: 1, processor: { online: false, offline_since: since.toISOString() } })
    expect(status).toHaveTextContent(
      'O processador está fora do ar desde 00:02; sua gravação está guardada e entra quando ele voltar.',
    )
  })

  it('server older than 2.16.0: the generic sentence', () => {
    expect(waiting(null)).toHaveTextContent('Aguardando a vez na fila de transcrição.')
  })
})
