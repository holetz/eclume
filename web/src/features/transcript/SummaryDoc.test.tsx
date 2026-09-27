import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fixtures } from '../../test/fixtures'
import { empty, json } from '../../test/http'
import { renderApp } from '../../test/render'
import { mockTranscriptApi, RECORDING_ID as RECORDING } from '../../test/transcriptApi'

afterEach(() => vi.unstubAllGlobals())

const ONE_ON_ONE = '01928f3a-1c00-7a00-8000-000000000902'

async function summarySection() {
  return screen.findByRole('region', { name: 'Resumo' })
}

describe('documento do resumo', () => {
  it('mostra o tipo, a origem e a versão, e o Markdown da versão atual', async () => {
    mockTranscriptApi()
    renderApp(`/gravacoes/${RECORDING}`)
    const section = await summarySection()
    const bar = section.querySelector('.doc-bar') as HTMLElement
    expect(within(bar).getByText('Tipo · Reunião de equipe')).toHaveClass('tag', 'tag-neutral')
    expect(bar).toHaveTextContent('Editado por você · versão 2')
    const doc = section.querySelector('.doc') as HTMLElement
    expect(within(doc).getByRole('heading', { name: 'Decisões' })).toBeInTheDocument()
    expect(within(doc).getByText(/Três turmas de 12 gestores cada/)).toBeInTheDocument()
    // Com resumo atual, o MD do Exportar fica habilitado.
    await userEvent.click(screen.getByRole('button', { name: 'Exportar' }))
    expect(screen.getByRole('menuitem', { name: /^Resumo/ })).not.toHaveAttribute('aria-disabled')
  })

  it('copia o título e o resumo, e avisa quando o navegador não deixa', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    mockTranscriptApi()
    renderApp(`/gravacoes/${RECORDING}`)
    const section = await summarySection()
    const copy = within(section).getByRole('button', { name: 'Copiar com título' })
    expect(copy).toHaveAttribute('title', 'Copia o título e o resumo')
    await user.click(copy)
    expect(writeText).toHaveBeenCalledWith(
      `# Alinhamento do programa de lideranças\n\n${fixtures.summaryState().current!.content_md}`,
    )
    expect(await within(section).findByText('Copiado')).toHaveAttribute('role', 'status')

    writeText.mockRejectedValueOnce(new Error('negado'))
    await user.click(copy)
    expect(await within(section).findByRole('alert')).toHaveTextContent('Não deu para copiar')
  })

  it('troca o tipo de agenda num diálogo e relê o resumo, que volta em geração', async () => {
    const user = userEvent.setup()
    let pending = false
    const http = mockTranscriptApi({
      'GET /api/v1/recordings/:id/summary': () => {
        const state = fixtures.summaryState()
        if (pending) state.pending = { ...fixtures.summaryQueued(), agenda_type: { id: ONE_ON_ONE, name: '1:1' } }
        return state
      },
      'PATCH /api/v1/recordings/:id': async (request) => {
        pending = true
        const body = (await request.json()) as { agenda_type_id: string }
        return {
          ...fixtures.recordingTranscribed(),
          agenda_type: { id: body.agenda_type_id, name: '1:1', origin: 'edited' },
        }
      },
    })
    renderApp(`/gravacoes/${RECORDING}`)
    const section = await summarySection()
    await user.click(within(section).getByRole('button', { name: 'Trocar tipo' }))
    const dialog = screen.getByRole('dialog', { name: 'Trocar o tipo de agenda' })
    expect(dialog).toHaveTextContent('Trocar o tipo gera um resumo novo pelas instruções do tipo; a versão atual fica guardada.')
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Tipo de agenda' }), '1:1')
    await user.click(within(dialog).getByRole('button', { name: 'Trocar e gerar' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(await http.requests('PATCH /api/v1/recordings/:id')[0].json()).toEqual({ agenda_type_id: ONE_ON_ONE })
    expect(await within(section).findByText('Gerando uma versão nova…')).toBeInTheDocument()
  })

  it('exclui o resumo com confirmação', async () => {
    const user = userEvent.setup()
    let deleted = false
    const http = mockTranscriptApi({
      'GET /api/v1/recordings/:id/summary': () =>
        deleted ? { current: null, generated: null, pending: null, version_count: 0 } : fixtures.summaryState(),
      'DELETE /api/v1/recordings/:id/summary': () => {
        deleted = true
        return empty()
      },
    })
    renderApp(`/gravacoes/${RECORDING}`)
    const section = await summarySection()
    await user.click(within(section).getByRole('button', { name: 'Excluir resumo' }))
    const dialog = screen.getByRole('dialog', { name: 'Excluir o resumo?' })
    await user.click(within(dialog).getByRole('button', { name: 'Excluir resumo' }))
    expect(await within(await summarySection()).findByText('Sem resumo.')).toBeInTheDocument()
    expect(http.requests('DELETE /api/v1/recordings/:id/summary')).toHaveLength(1)
  })

  it('em geração sem versão, diz o tipo; sem resumo, gera, e sem tipo pede um', async () => {
    const user = userEvent.setup()
    let state: unknown = {
      current: null,
      generated: null,
      pending: { ...fixtures.summaryQueued(), agenda_type: { id: 'x', name: 'Reunião de equipe' } },
      version_count: 0,
    }
    const http = mockTranscriptApi({
      'GET /api/v1/recordings/:id/summary': () => state,
      'POST /api/v1/transcripts/:id/summaries': () =>
        json(
          {
            type: 'about:blank',
            title: 'validation_failed',
            status: 422,
            code: 'validation_failed',
            errors: [{ field: 'agenda_type_id', message: 'a gravação não tem tipo de agenda' }],
          },
          422,
        ),
    })
    renderApp(`/gravacoes/${RECORDING}`)
    const busy = await screen.findByText('Resumindo pelas instruções de Reunião de equipe…')
    expect(busy).toHaveAttribute('aria-busy', 'true')
    // O Exportar não oferece o MD sem versão atual.
    await user.click(screen.getByRole('button', { name: 'Exportar' }))
    expect(screen.getByRole('menuitem', { name: /^Resumo/ })).toHaveAttribute('aria-disabled', 'true')
    await user.keyboard('{Escape}')

    state = { current: null, generated: null, pending: null, version_count: 0 }
    await waitFor(() => expect(screen.getByText('Sem resumo.')).toBeInTheDocument(), { timeout: 5000 })
    await user.click(screen.getByRole('button', { name: 'Gerar resumo' }))
    expect(await screen.findByText('Escolha um tipo de agenda para gerar o resumo.')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Trocar o tipo de agenda' })).toBeInTheDocument()
    expect(http.requests('POST /api/v1/transcripts/:id/summaries')).toHaveLength(1)
  }, 15_000)

  it('geração que falhou mostra a mensagem e tenta de novo', async () => {
    const user = userEvent.setup()
    const recording = fixtures.recordingTranscribed()
    recording.pipeline = recording.pipeline.map((step) =>
      step.step === 'summary'
        ? { ...step, state: 'failed', error: { code: 'provider_timeout', message: 'O agente não respondeu a tempo.' } }
        : step,
    )
    const http = mockTranscriptApi({
      'GET /api/v1/recordings/:id': () => recording,
      'GET /api/v1/recordings/:id/summary': () => ({ current: null, generated: null, pending: null, version_count: 0 }),
      'POST /api/v1/transcripts/:id/summaries': () => json(fixtures.summaryQueued(), 202),
    })
    renderApp(`/gravacoes/${RECORDING}`)
    const section = await summarySection()
    expect(await within(section).findByRole('alert')).toHaveTextContent('O agente não respondeu a tempo.')
    await user.click(within(section).getByRole('button', { name: 'Tentar de novo' }))
    await waitFor(() => expect(http.requests('POST /api/v1/transcripts/:id/summaries')).toHaveLength(1))
    expect(await http.requests('POST /api/v1/transcripts/:id/summaries')[0].json()).toEqual({})
  })
})
