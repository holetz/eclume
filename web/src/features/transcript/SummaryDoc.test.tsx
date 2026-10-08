import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { fixtures } from '../../test/fixtures'
import { empty, json } from '../../test/http'
import { preloadRoute, renderApp } from '../../test/render'
import { mockTranscriptApi, RECORDING_ID as RECORDING } from '../../test/transcriptApi'

beforeAll(() => preloadRoute('/gravacoes/x'))

afterEach(() => {
  vi.unstubAllGlobals()
  window.sessionStorage.clear()
})

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
    // O selo leva ao tipo em Tipos de agenda, para ajustar o modelo do resumo.
    expect(
      await within(bar).findByRole('link', { name: 'Tipo · Reunião de equipe: ajustar o modelo deste tipo' }),
    ).toHaveAttribute('href', '/config/agendas?tipo=01928f3a-1c00-7a00-8000-000000000901')
    expect(bar).toHaveTextContent('Editado por você · versão 2')
    const doc = section.querySelector('.doc') as HTMLElement
    expect(within(doc).getByRole('heading', { name: 'Decisões' })).toBeInTheDocument()
    expect(within(doc).getByText(/Três turmas de 12 gestores cada/)).toBeInTheDocument()
    // Com resumo atual, o MD do Exportar fica habilitado.
    await userEvent.click(screen.getByRole('button', { name: 'Exportar' }))
    expect(screen.getByRole('menuitem', { name: /^Resumo/ })).not.toHaveAttribute('aria-disabled')
  })

  it('avisa quando o resumo é de uma revisão anterior da transcrição e não avisa quando coincidem', async () => {
    mockTranscriptApi()
    const { unmount } = renderApp(`/gravacoes/${RECORDING}`)
    const section = await summarySection()
    expect(within(section).queryByText('Resumo de uma versão anterior da transcrição')).not.toBeInTheDocument()
    unmount()

    mockTranscriptApi({
      'GET /api/v1/transcripts/:id': () => {
        const transcript = fixtures.transcript()
        transcript.revision += 1
        return transcript
      },
    })
    renderApp(`/gravacoes/${RECORDING}`)
    const stale = await screen.findByText('Resumo de uma versão anterior da transcrição')
    expect(stale.closest('.alert')).toHaveClass('alert-warning')
  })

  it('não avisa enquanto a transcrição não carregou', async () => {
    mockTranscriptApi({ 'GET /api/v1/transcripts/:id': () => new Promise<Response>(() => {}) })
    renderApp(`/gravacoes/${RECORDING}`)
    const section = await summarySection()
    expect(within(section).queryByText('Resumo de uma versão anterior da transcrição')).not.toBeInTheDocument()
  })

  it('o selo de um tipo que não existe mais fica sem link', async () => {
    const http = mockTranscriptApi({ 'GET /api/v1/agenda-types': () => ({ items: [], next_cursor: null }) })
    renderApp(`/gravacoes/${RECORDING}`)
    const section = await summarySection()
    await waitFor(() => expect(http.requests('GET /api/v1/agenda-types').length).toBeGreaterThan(0))
    const bar = section.querySelector('.doc-bar') as HTMLElement
    expect(within(bar).getByText('Tipo · Reunião de equipe').tagName).toBe('SPAN')
    expect(within(bar).queryByRole('link', { name: /ajustar o modelo/ })).not.toBeInTheDocument()
  })

  it('copia o título e o resumo em HTML e texto, com os títulos em negrito, e avisa quando o navegador não deixa', async () => {
    const user = userEvent.setup()
    const write = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { write }, configurable: true })
    vi.stubGlobal(
      'ClipboardItem',
      class {
        items: Record<string, Promise<Blob>>
        constructor(items: Record<string, Promise<Blob>>) {
          this.items = items
        }
      },
    )
    mockTranscriptApi()
    renderApp(`/gravacoes/${RECORDING}`)
    const section = await summarySection()
    const copy = within(section).getByRole('button', { name: 'Copiar com título' })
    expect(copy).toHaveAttribute('title', 'Copia o título e o resumo')
    await user.click(copy)
    expect(await within(section).findByText('Copiado')).toHaveAttribute('role', 'status')
    const { items } = write.mock.calls[0][0][0] as { items: Record<string, Promise<Blob>> }
    expect(Object.keys(items).sort()).toEqual(['text/html', 'text/plain'])
    const html = await (await items['text/html']).text()
    expect(html.startsWith('<p><strong>Alinhamento do programa de lideranças</strong></p>')).toBe(true)
    expect(html).toContain('<p><strong>Decisões</strong></p>')
    expect(html).not.toMatch(/<h[1-6]/)
    const text = await (await items['text/plain']).text()
    expect(text.startsWith('Alinhamento do programa de lideranças\n\n')).toBe(true)
    expect(text).not.toMatch(/^#/m)

    write.mockRejectedValueOnce(new Error('negado'))
    await user.click(copy)
    expect(await within(section).findByRole('alert')).toHaveTextContent('Não deu para copiar')
  })

  it('sem ClipboardItem, copia o texto puro sem as hashtags dos títulos', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    vi.stubGlobal('ClipboardItem', undefined)
    mockTranscriptApi()
    renderApp(`/gravacoes/${RECORDING}`)
    const section = await summarySection()
    await user.click(within(section).getByRole('button', { name: 'Copiar com título' }))
    expect(await within(section).findByText('Copiado')).toBeInTheDocument()
    const copied = writeText.mock.calls[0][0] as string
    expect(copied.startsWith('Alinhamento do programa de lideranças\n\n')).toBe(true)
    expect(copied).not.toMatch(/^#/m)
  })

  it('regenera o resumo só depois de confirmar, pelo tipo da gravação, e espera a geração', async () => {
    const user = userEvent.setup()
    let pending = false
    const http = mockTranscriptApi({
      'GET /api/v1/recordings/:id/summary': () => {
        const state = fixtures.summaryState()
        if (pending) state.pending = fixtures.summaryQueued()
        return state
      },
      'POST /api/v1/transcripts/:id/summaries': () => {
        pending = true
        return json(fixtures.summaryQueued(), 202)
      },
    })
    renderApp(`/gravacoes/${RECORDING}`)
    const section = await summarySection()
    const regenerate = within(section).getByRole('button', { name: 'Regenerar' })

    await user.click(regenerate)
    let dialog = screen.getByRole('dialog', { name: 'Regenerar o resumo?' })
    expect(dialog).toHaveTextContent('A nova versão passa a ser a atual')
    expect(dialog).toHaveTextContent('a versão 2 (Editado por você) fica guardada')
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(http.requests('POST /api/v1/transcripts/:id/summaries')).toHaveLength(0)

    await user.click(regenerate)
    dialog = screen.getByRole('dialog', { name: 'Regenerar o resumo?' })
    await user.click(within(dialog).getByRole('button', { name: 'Regenerar' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(await http.requests('POST /api/v1/transcripts/:id/summaries')[0].json()).toEqual({})
    expect(await within(section).findByText('Gerando uma versão nova…')).toBeInTheDocument()
    expect(within(section).getByRole('button', { name: 'Regenerar' })).toBeDisabled()
  })

  it('regenerar sem tipo de agenda abre o diálogo de trocar o tipo', async () => {
    const user = userEvent.setup()
    mockTranscriptApi({
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
    const section = await summarySection()
    await user.click(within(section).getByRole('button', { name: 'Regenerar' }))
    await user.click(within(screen.getByRole('dialog', { name: 'Regenerar o resumo?' })).getByRole('button', { name: 'Regenerar' }))
    expect(await screen.findByRole('dialog', { name: 'Trocar o tipo de agenda' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Regenerar o resumo?' })).not.toBeInTheDocument()
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
    expect(dialog).toHaveTextContent(
      'Trocar o tipo gera um resumo novo pelas instruções do tipo; a versão atual fica guardada.',
    )
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

  it('sem agente de resumo, diz o motivo e tenta de novo como ação secundária, sem 422 cru', async () => {
    const user = userEvent.setup()
    const recording = fixtures.recordingTranscribed()
    recording.pipeline = recording.pipeline.map((step) =>
      step.step === 'summary' ? { ...step, state: 'skipped', reason: 'no_provider' } : step,
    )
    mockTranscriptApi({
      'GET /api/v1/recordings/:id': () => recording,
      'GET /api/v1/recordings/:id/summary': () => ({ current: null, generated: null, pending: null, version_count: 0 }),
      'POST /api/v1/transcripts/:id/summaries': () =>
        json(
          {
            type: 'about:blank',
            title: 'validation_failed',
            status: 422,
            code: 'validation_failed',
            errors: [{ field: 'provider_id', message: 'nenhum provider de resumo configurado' }],
          },
          422,
        ),
    })
    renderApp(`/gravacoes/${RECORDING}`)
    const section = await summarySection()
    const reason = 'Sem resumo: nenhum agente configurado; fale com quem administra.'
    expect(await within(section).findByText(reason)).toBeInTheDocument()
    expect(within(section).queryByRole('button', { name: 'Gerar resumo' })).not.toBeInTheDocument()
    const retry = within(section).getByRole('button', { name: 'Tentar de novo' })
    expect(retry).toHaveClass('btn-secondary')
    await user.click(retry)
    expect(await within(section).findByRole('alert')).toHaveTextContent(reason)
    expect(within(section).queryByText(/provider_id/)).not.toBeInTheDocument()
  })
})

describe('edição do resumo', () => {
  async function openEditor() {
    const section = await summarySection()
    await userEvent.click(within(section).getByRole('button', { name: 'Editar' }))
    return screen.getByRole('region', { name: 'Editando o resumo' })
  }

  it('edita o Markdown e salva sobre a versão aberta', async () => {
    const user = userEvent.setup()
    const http = mockTranscriptApi({
      'PUT /api/v1/recordings/:id/summary': async (request) => ({
        ...fixtures.summaryState().current,
        ...((await request.json()) as object),
        version: 3,
      }),
    })
    renderApp(`/gravacoes/${RECORDING}`)
    const editor = await openEditor()
    expect(within(editor).getByText('Editando')).toHaveClass('kicker')
    expect(editor).toHaveTextContent('A versão gerada fica guardada')
    const text = within(editor).getByRole('textbox', { name: 'Resumo em Markdown' })
    expect(text).toHaveValue(fixtures.summaryState().current!.content_md)
    expect(text.closest('.doc')).toHaveClass('doc-editing')
    await user.clear(text)
    await user.type(text, '# Ata curta')
    await user.click(within(editor).getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Editando o resumo' })).not.toBeInTheDocument())
    expect(await http.requests('PUT /api/v1/recordings/:id/summary')[0].json()).toEqual({
      content_md: '# Ata curta',
      base_version: 2,
    })
  })

  it('Ctrl+Enter salva; Esc sem mudança cancela e com mudança pede confirmação', async () => {
    const user = userEvent.setup()
    const http = mockTranscriptApi({
      'PUT /api/v1/recordings/:id/summary': () => fixtures.summaryState().current,
    })
    renderApp(`/gravacoes/${RECORDING}`)
    await openEditor()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('region', { name: 'Editando o resumo' })).not.toBeInTheDocument()

    const editor = await openEditor()
    await user.type(within(editor).getByRole('textbox'), ' mais')
    await user.keyboard('{Escape}')
    const confirm = screen.getByRole('dialog', { name: 'Descartar a edição?' })
    await user.click(within(confirm).getByRole('button', { name: 'Cancelar' }))
    expect(within(editor).getByRole('textbox')).toHaveValue(`${fixtures.summaryState().current!.content_md} mais`)
    await user.keyboard('{Control>}{Enter}{/Control}')
    await waitFor(() => expect(http.requests('PUT /api/v1/recordings/:id/summary')).toHaveLength(1))
  })

  it('quando o resumo muda enquanto edita, guarda o rascunho, mostra a nova e salva sobre ela', async () => {
    const user = userEvent.setup()
    let changed = false
    const http = mockTranscriptApi({
      'GET /api/v1/recordings/:id/summary': () => {
        const state = fixtures.summaryState()
        if (changed) state.current = { ...state.current!, version: 3, origin: 'chat', content_md: '# Ata do chat' }
        return state
      },
      'PUT /api/v1/recordings/:id/summary': async (request) => {
        const body = (await request.json()) as { base_version: number }
        if (body.base_version === 2) {
          changed = true
          return json({ type: 'about:blank', title: 'summary_changed', status: 409, code: 'summary_changed' }, 409)
        }
        return { ...fixtures.summaryState().current, version: 4 }
      },
    })
    renderApp(`/gravacoes/${RECORDING}`)
    const editor = await openEditor()
    const text = within(editor).getByRole('textbox')
    await user.clear(text)
    await user.type(text, '# Meu rascunho')
    await user.click(within(editor).getByRole('button', { name: 'Salvar' }))
    const warning = await within(editor).findByText('O resumo mudou enquanto você editava (agora na versão 3).')
    expect(warning.closest('.alert')).toHaveClass('alert-warning')
    expect(text).toHaveValue('# Meu rascunho')

    await user.click(within(editor).getByRole('button', { name: 'Ver a versão 3' }))
    const diff = within(editor).getByRole('region', { name: 'Seu rascunho e a versão 3' })
    expect(within(diff).getByText('# Meu rascunho').closest('del')).not.toBeNull()
    expect(within(diff).getByText('# Ata do chat').closest('ins')).not.toBeNull()

    await user.click(within(editor).getByRole('button', { name: 'Salvar sobre a versão 3' }))
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Editando o resumo' })).not.toBeInTheDocument())
    const bodies = await Promise.all(http.requests('PUT /api/v1/recordings/:id/summary').map((r) => r.json()))
    expect(bodies.map((body) => body.base_version)).toEqual([2, 3])
    expect(bodies[1].content_md).toBe('# Meu rascunho')
  })

  it('guarda o rascunho na aba, reencontra depois de recarregar e apaga ao descartar', async () => {
    const user = userEvent.setup()
    mockTranscriptApi()
    const first = renderApp(`/gravacoes/${RECORDING}`)
    const text = within(await openEditor()).getByRole('textbox')
    await user.clear(text)
    await user.type(text, '# Rascunho guardado')
    const key = `eclume-resumo-rascunho:${RECORDING}`
    await waitFor(() =>
      expect(JSON.parse(window.sessionStorage.getItem(key) ?? 'null')).toEqual({
        base_version: 2,
        content_md: '# Rascunho guardado',
      }),
    )

    first.unmount()
    renderApp(`/gravacoes/${RECORDING}`)
    const editor = await openEditor()
    expect(within(editor).getByRole('textbox')).toHaveValue('# Rascunho guardado')
    expect(within(editor).queryByRole('alert')).not.toBeInTheDocument()
    await user.click(within(editor).getByRole('button', { name: 'Cancelar' }))
    const confirm = screen.getByRole('dialog', { name: 'Descartar a edição?' })
    await user.click(within(confirm).getByRole('button', { name: 'Descartar' }))
    expect(window.sessionStorage.getItem(key)).toBeNull()
  })

  it('rascunho guardado sobre uma versão antiga volta com o aviso de conflito', async () => {
    window.sessionStorage.setItem(
      `eclume-resumo-rascunho:${RECORDING}`,
      JSON.stringify({ base_version: 1, content_md: '# Rascunho antigo' }),
    )
    mockTranscriptApi()
    renderApp(`/gravacoes/${RECORDING}`)
    const editor = await openEditor()
    expect(within(editor).getByRole('textbox')).toHaveValue('# Rascunho antigo')
    expect(within(editor).getByText('O resumo mudou enquanto você editava (agora na versão 2).')).toBeInTheDocument()
    expect(within(editor).getByRole('button', { name: 'Salvar sobre a versão 2' })).toBeInTheDocument()
  })

  it('sair pela barra com rascunho pede confirmação, e continuar editando mantém o texto', async () => {
    const user = userEvent.setup()
    mockTranscriptApi()
    renderApp(`/gravacoes/${RECORDING}`)
    const editor = await openEditor()
    const text = within(editor).getByRole('textbox')
    await user.type(text, ' mais')
    const nav = screen.getByRole('navigation', { name: 'Principal' })
    await user.click(within(nav).getByRole('link', { name: 'Biblioteca' }))
    const confirm = await screen.findByRole('dialog', { name: 'Descartar a edição?' })
    await user.click(within(confirm).getByRole('button', { name: 'Continuar editando' }))
    expect(screen.queryByRole('dialog', { name: 'Descartar a edição?' })).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Editando o resumo' })).toBeInTheDocument()
    expect(text).toHaveValue(`${fixtures.summaryState().current!.content_md} mais`)
  })

  it('volta à gerada com confirmação', async () => {
    const user = userEvent.setup()
    const http = mockTranscriptApi({
      'POST /api/v1/recordings/:id/summary/revert': () =>
        json({ ...fixtures.summaryState().generated, version: 3 }, 201),
    })
    renderApp(`/gravacoes/${RECORDING}`)
    const editor = await openEditor()
    await user.click(within(editor).getByRole('button', { name: 'Voltar à gerada' }))
    const confirm = screen.getByRole('dialog', { name: 'Voltar à versão gerada?' })
    await user.click(within(confirm).getByRole('button', { name: 'Voltar à gerada' }))
    await waitFor(() => expect(http.requests('POST /api/v1/recordings/:id/summary/revert')).toHaveLength(1))
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Editando o resumo' })).not.toBeInTheDocument())
  })

  it('compara a atual com a gerada por linha, com sinal para quem não vê cor', async () => {
    const user = userEvent.setup()
    mockTranscriptApi()
    renderApp(`/gravacoes/${RECORDING}`)
    const section = await summarySection()
    await user.click(within(section).getByRole('button', { name: 'Comparar com a gerada' }))
    const diff = within(section).getByRole('region', { name: 'A gerada (versão 1) e a atual (versão 2)' })
    const removed = diff.querySelectorAll('del')
    const added = diff.querySelectorAll('ins')
    expect(removed).toHaveLength(1)
    expect(added).toHaveLength(1)
    expect(removed[0]).toHaveTextContent('−- Três turmas de 12 gestores; a primeira')
    expect(added[0]).toHaveTextContent('+- Três turmas de 12 gestores cada;')
    await user.click(within(section).getByRole('button', { name: 'Fechar comparação' }))
    expect(within(section).queryByRole('region', { name: /A gerada/ })).not.toBeInTheDocument()
  })
})
