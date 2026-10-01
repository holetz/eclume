import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { CSRF_HEADER } from '../../api/client'
import { fixtures } from '../../test/fixtures'
import { problem } from '../../test/http'
import { preloadRoute, renderApp } from '../../test/render'
import { mockTranscriptApi, openTranscript, RECORDING_ID } from '../../test/transcriptApi'

beforeAll(() => preloadRoute('/gravacoes/x'))

afterEach(() => {
  vi.unstubAllGlobals()
  document.cookie = 'eclume_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/'
})

async function openPage() {
  renderApp(`/gravacoes/${RECORDING_ID}`)
  await openTranscript()
  return screen.findByRole('region', { name: 'Locutores' })
}

describe('edição da transcrição', () => {
  it('renomeia um locutor e atualiza as falas dele', async () => {
    document.cookie = 'eclume_csrf=abc; path=/'
    const http = mockTranscriptApi({
      'PATCH /api/v1/transcripts/:id/speakers/:speaker': async (request) => {
        const body = (await request.json()) as { label: string }
        return { ...fixtures.transcript().speakers[2], label: body.label }
      },
    })
    const panel = await openPage()
    await userEvent.click(within(panel).getByRole('button', { name: 'Renomear Locutor 3' }))
    const input = within(panel).getByLabelText('Novo nome de Locutor 3')
    await userEvent.clear(input)
    await userEvent.type(input, 'Joana Prado{Enter}')

    expect(await within(panel).findByText('Joana Prado')).toBeInTheDocument()
    const falas = screen.getByRole('list', { name: 'Falas' })
    expect(within(falas).getAllByText('Joana Prado')).toHaveLength(3)
    const request = http.requests('PATCH /api/v1/transcripts/:id/speakers/:speaker')[0]
    expect(new URL(request.url).pathname).toMatch(/\/speakers\/S3$/)
    expect(request.headers.get(CSRF_HEADER)).toBe('abc')
  })

  it('mostra o erro de uma renomeação recusada', async () => {
    mockTranscriptApi({
      'PATCH /api/v1/transcripts/:id/speakers/:speaker': () => problem('forbidden', 403),
    })
    const panel = await openPage()
    await userEvent.click(within(panel).getByRole('button', { name: 'Renomear Locutor 2' }))
    await userEvent.click(within(panel).getByRole('button', { name: 'Salvar' }))
    expect(await within(panel).findByRole('alert')).toHaveTextContent(/permissão/)
  })

  it('mescla locutores e passa a mostrar a transcrição devolvida', async () => {
    const merged = fixtures.transcript()
    merged.speakers = merged.speakers.filter((s) => s.id !== 'S3')
    merged.segments = merged.segments.map((s) => (s.speaker_id === 'S3' ? { ...s, speaker_id: 'S2' } : s))
    const http = mockTranscriptApi({
      'POST /api/v1/transcripts/:id/speakers/merge': () => merged,
    })
    const panel = await openPage()
    await userEvent.click(within(panel).getByRole('button', { name: 'Mesclar locutores' }))
    await userEvent.selectOptions(within(panel).getByLabelText('Manter o locutor'), 'S2')
    const mesclar = within(panel).getByRole('button', { name: 'Mesclar' })
    expect(mesclar).toBeDisabled()
    await userEvent.click(within(panel).getByRole('checkbox', { name: 'Locutor 3' }))
    await userEvent.click(mesclar)

    expect(await within(panel).findByText('Locutor 3 mesclado em Locutor 2.')).toBeInTheDocument()
    expect(within(panel).queryByRole('button', { name: 'Renomear Locutor 3' })).not.toBeInTheDocument()
    const body = await http.requests('POST /api/v1/transcripts/:id/speakers/merge')[0].json()
    expect(body).toEqual({ source_speaker_ids: ['S3'], target_speaker_id: 'S2' })
  })

  it('corrige o texto de uma fala', async () => {
    const http = mockTranscriptApi({
      'PATCH /api/v1/transcripts/:id/segments/:segment': async (request) => {
        const body = (await request.json()) as { text: string }
        return { ...fixtures.transcript().segments[1], text: body.text }
      },
    })
    await openPage()
    const falas = screen.getByRole('list', { name: 'Falas' })
    await userEvent.click(within(falas).getByRole('button', { name: 'Corrigir a fala de Locutor 2 em 00:00:12' }))
    const field = within(falas).getByLabelText('Texto da fala de Locutor 2 em 00:00:12')
    await userEvent.clear(field)
    await userEvent.type(field, 'Texto corrigido.{Control>}{Enter}{/Control}')

    expect(await within(falas).findByText('Texto corrigido.')).toBeInTheDocument()
    expect(within(falas).queryByRole('textbox')).not.toBeInTheDocument()
    const request = http.requests('PATCH /api/v1/transcripts/:id/segments/:segment')[0]
    expect(new URL(request.url).pathname).toMatch(/\/segments\/seg-0002$/)
    expect(await request.json()).toEqual({ text: 'Texto corrigido.' })
  })

  it('Esc cancela a correção sem chamar a API', async () => {
    const http = mockTranscriptApi()
    await openPage()
    const falas = screen.getByRole('list', { name: 'Falas' })
    await userEvent.click(within(falas).getByRole('button', { name: 'Corrigir a fala de Locutor 2 em 00:00:12' }))
    await userEvent.type(within(falas).getByRole('textbox'), ' extra{Escape}')
    expect(within(falas).queryByRole('textbox')).not.toBeInTheDocument()
    expect(http.calls.some((r) => r.method === 'PATCH')).toBe(false)
  })
})
