import { render, screen } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import type { Schemas } from '../../api/client'
import { createQueryClient } from '../../app/queryClient'
import { fixtures } from '../../test/fixtures'
import { Pipeline } from './Pipeline'

type Queue = NonNullable<Schemas['Job']['queue']>

const EM_12_MIN = () => new Date(Date.now() + 12 * 60_000 + 20_000).toISOString()

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

describe('a espera na fila', () => {
  it('mostra a posição e a previsão rotulada como estimativa', () => {
    expect(waiting({ ahead: 2, estimated_start_at: EM_12_MIN() })).toHaveTextContent(
      '3ª na fila · começa em cerca de 12 min (estimativa)',
    )
  })

  it('sem histórico, só a posição', () => {
    expect(waiting({ ahead: 0 })).toHaveTextContent(/^1ª na fila$/)
  })

  it('atrás das gravações da própria conta', () => {
    expect(waiting({ reason: 'account_turn', account_ahead: 2 })).toHaveTextContent(
      'Atrás de 2 gravações suas que chegaram antes.',
    )
  })

  it('na janela de minutos, diz quando libera', () => {
    const at = new Date()
    at.setHours(23, 59, 0, 0)
    expect(waiting({ reason: 'quota_window', resumes_at: at.toISOString() })).toHaveTextContent(
      'Seus minutos de transcrição das últimas 24 h acabaram; a gravação entra às 23:59.',
    )
  })

  it('com o processador fora do ar, diz desde quando e que a gravação está guardada', () => {
    const since = new Date()
    since.setHours(0, 2, 0, 0)
    const status = waiting({ ahead: 1, processor: { online: false, offline_since: since.toISOString() } })
    expect(status).toHaveTextContent(
      'O processador está fora do ar desde 00:02; sua gravação está guardada e entra quando ele voltar.',
    )
  })

  it('servidor anterior à 2.16.0: a frase genérica', () => {
    expect(waiting(null)).toHaveTextContent('Aguardando a vez na fila de transcrição.')
  })
})
