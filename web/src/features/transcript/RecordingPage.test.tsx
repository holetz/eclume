import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { fixtures } from '../../test/fixtures'
import { empty, mockFetch, problem } from '../../test/http'
import { preloadRoute, renderApp } from '../../test/render'
import { mockTranscriptApi, openTranscript, RECORDING_ID as RECORDING } from '../../test/transcriptApi'

beforeAll(() => preloadRoute('/gravacoes/x'))

afterEach(() => vi.unstubAllGlobals())

describe('cabeçalho, pipeline, exportar e excluir', () => {
  it('mostra a data, a hora e a duração no kicker, o título e as seis etapas', async () => {
    mockTranscriptApi()
    renderApp(`/gravacoes/${RECORDING}`)
    const title = await screen.findByRole('heading', { level: 1, name: 'Alinhamento do programa de lideranças' })
    expect(title.previousElementSibling).toHaveTextContent('sex 18 set 2026 · 11:00 · 2 min 46 s')
    expect(title.previousElementSibling).toHaveClass('kicker')
    expect(screen.getByRole('link', { name: '← Biblioteca' })).toHaveAttribute('href', '/')

    const steps = within(screen.getByRole('list', { name: 'Processamento' })).getAllByRole('listitem')
    expect(steps.map((step) => step.textContent)).toEqual([
      'Áudio recebido',
      'Pré-processamento',
      'Transcrição',
      'Tipo de agenda',
      'Campos',
      'Resumo',
    ])
    expect(steps.every((step) => step.dataset.state === 'done')).toBe(true)
    expect(document.querySelector('aside.chat')).toHaveTextContent('Ajustar o resumo')
  })

  it('mostra a referência curta da gravação sob o título, com o id completo na dica', async () => {
    mockTranscriptApi()
    renderApp(`/gravacoes/${RECORDING}`)
    const title = await screen.findByRole('heading', { level: 1, name: 'Alinhamento do programa de lideranças' })
    const ref = title.nextElementSibling as HTMLElement
    expect(ref).toHaveTextContent(`ref. ${RECORDING.replace(/-/g, '').slice(0, 8)}`)
    expect(ref).toHaveAttribute('title', `ID completo: ${RECORDING}`)
  })

  it('etapa pulada ou que falhou diz o motivo, e a data do envio aparece no kicker', async () => {
    const recording = fixtures.recordingTranscribed()
    recording.recorded_at_source = 'upload'
    recording.pipeline = recording.pipeline.map((step) =>
      step.step === 'summary'
        ? { ...step, state: 'failed', error: { code: 'provider_timeout', message: 'O agente não respondeu a tempo.' } }
        : step.step === 'agenda_type'
          ? { ...step, state: 'skipped', reason: 'no_types' }
          : step,
    )
    mockTranscriptApi({ 'GET /api/v1/recordings/:id': () => recording })
    renderApp(`/gravacoes/${RECORDING}`)
    // O estado está no texto da etapa, e o motivo numa linha visível sob a barra, não só no `title`.
    const skipped = await screen.findByText('Tipo de agenda · pulada', { selector: 'ol li' })
    expect(skipped).toHaveAttribute('data-state', 'skipped')
    expect(screen.getByText('Resumo · falhou', { selector: 'ol li' })).toHaveAttribute('data-state', 'failed')
    const reasons = within(screen.getByRole('list', { name: 'Motivos das etapas' })).getAllByRole('listitem')
    expect(reasons.map((item) => item.textContent)).toEqual([
      'Tipo de agenda · pulada: só o tipo padrão está cadastrado: ficou ele',
      'Resumo · falhou: O agente não respondeu a tempo.',
    ])
    expect(screen.getByText(/· data do envio$/)).toHaveClass('kicker')
  })

  it('exporta pelo menu com fetch e mostra o erro da API num alerta', async () => {
    const user = userEvent.setup()
    const createObjectURL = vi.fn(() => 'blob:export')
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }))
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const http = mockTranscriptApi({
      'GET /api/v1/recordings/:id/export': (request) =>
        new URL(request.url).searchParams.get('format') === 'md'
          ? problem('summary_missing', 409, { detail: 'A gravação ainda não tem resumo.' })
          : new Response('conteúdo', {
              headers: { 'Content-Disposition': 'attachment; filename="alinhamento-do-programa.docx"' },
            }),
    })
    renderApp(`/gravacoes/${RECORDING}`)
    const button = await screen.findByRole('button', { name: 'Exportar' })
    expect(button).toHaveAttribute('aria-haspopup', 'menu')
    await user.click(button)
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem')
    expect(items.map((item) => item.textContent)).toEqual([
      'TranscriçãoTXT',
      'Transcrição com temposSRT',
      'ResumoMD',
      'Transcrição e resumoDOCX',
    ])
    await user.click(screen.getByRole('menuitem', { name: /Transcrição e resumo/ }))
    await waitFor(() => expect(click).toHaveBeenCalled())
    const link = click.mock.contexts[0] as HTMLAnchorElement
    expect(link.download).toBe('alinhamento-do-programa.docx')
    expect(http.requests('GET /api/v1/recordings/:id/export')[0].url).toMatch(/format=docx$/)

    await user.click(screen.getByRole('button', { name: 'Exportar' }))
    await user.click(screen.getByRole('menuitem', { name: /^Resumo/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('A gravação ainda não tem resumo.')
    click.mockRestore()
  })

  it('exclui com confirmação e volta para a biblioteca de onde veio, com o aviso', async () => {
    const user = userEvent.setup()
    const http = mockTranscriptApi({
      'DELETE /api/v1/recordings/:id': () => empty(),
      'GET /api/v1/recordings': () => fixtures.recordingWeekPage(),
      'GET /api/v1/fields': () => fixtures.fieldPage(),
    })
    renderApp(`/gravacoes/${RECORDING}`)
    await user.click(await screen.findByRole('button', { name: 'Excluir' }))
    const dialog = screen.getByRole('dialog', { name: 'Excluir a gravação?' })
    expect(dialog).toHaveTextContent(
      'O áudio, a transcrição, o resumo com as versões, o chat e os marcadores são apagados.',
    )
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }))
    expect(http.requests('DELETE /api/v1/recordings/:id')).toHaveLength(0)

    await user.click(screen.getByRole('button', { name: 'Excluir' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Excluir' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Biblioteca' })).toBeInTheDocument()
    expect(screen.getByText('Gravação excluída.')).toHaveAttribute('role', 'status')
    expect(http.requests('DELETE /api/v1/recordings/:id')).toHaveLength(1)
  })
})

/** A fala (`.segment`) de um item da lista de falas. */
const segment = (item: HTMLElement) => item.querySelector('.segment')!

describe('transcrição recolhida', () => {
  it('fica fechada, com o resumo de locutores, falas e marcadores, e só renderiza as falas aberta', async () => {
    mockTranscriptApi()
    renderApp(`/gravacoes/${RECORDING}`)
    const details = await waitFor(() => {
      const found = document.querySelector('details.disclosure')
      expect(found).not.toBeNull()
      return found as HTMLDetailsElement
    })
    expect(details.open).toBe(false)
    expect(details.querySelector('summary')).toHaveTextContent(
      'Transcrição3 locutores · 12 falas · 2 marcadores · abra para conferir ou corrigir',
    )
    expect(screen.queryByRole('list', { name: 'Falas' })).not.toBeInTheDocument()
    await openTranscript()
    expect(details.open).toBe(true)
    expect(screen.getByRole('region', { name: 'Locutores' })).toBeInTheDocument()
  })

  it('abre sozinha com ?t=, posiciona o áudio sem tocar e destaca a fala', async () => {
    mockTranscriptApi()
    renderApp(`/gravacoes/${RECORDING}?t=80900`)
    const falas = await screen.findByRole('list', { name: 'Falas' })
    const items = within(falas).getAllByRole('listitem')
    expect(segment(items[6])).toHaveAttribute('aria-current', 'true')
    const audio = screen.getByLabelText('Áudio da gravação') as HTMLAudioElement
    expect(audio.currentTime).toBe(80.9)
    expect(audio.play).not.toHaveBeenCalled()
    // A lista vem à janela e a fala é centrada por dentro dela.
    expect(vi.mocked(Element.prototype.scrollIntoView).mock.contexts).toContain(falas)
    expect(vi.mocked(Element.prototype.scrollTo).mock.contexts).toContain(falas)
  })

  it('põe o marcador antes da fala, com a nota, o dispositivo, editar e excluir', async () => {
    const user = userEvent.setup()
    const http = mockTranscriptApi({
      'PATCH /api/v1/markers/:id': async (request) => ({
        ...fixtures.markerPage().items[1],
        note: ((await request.json()) as { note: string }).note,
      }),
      'DELETE /api/v1/markers/:id': () => empty(),
    })
    renderApp(`/gravacoes/${RECORDING}`)
    await openTranscript()
    const falas = await screen.findByRole('list', { name: 'Falas' })
    const marker = await within(falas).findByRole('group', { name: 'Marcador em 00:00:42' })
    expect(marker).toHaveClass('segment-marker')
    expect(marker).toHaveTextContent('Decisão sobre as turmas')
    expect(marker).toHaveTextContent('Marcado no NB-MARIANA')
    // O marcador fica antes da primeira fala que começa nele ou depois.
    const item = marker.closest('[role="listitem"]') as HTMLElement
    expect(marker.nextElementSibling).toBe(segment(item))
    expect(Number(segment(item).textContent?.match(/00:00:(\d\d)/)?.[1])).toBeGreaterThanOrEqual(42)

    const empty2 = within(falas).getByRole('group', { name: 'Marcador em 00:02:11' })
    expect(empty2).toHaveTextContent('Marcador')
    await user.click(within(empty2).getByRole('button', { name: 'Editar nota' }))
    const input = within(empty2).getByRole('textbox', { name: 'Nota do marcador em 00:02:11' })
    expect(input).toHaveAttribute('maxLength', '500')
    await user.type(input, 'Próximos passos{Enter}')
    await waitFor(() => expect(http.requests('PATCH /api/v1/markers/:id')).toHaveLength(1))
    expect(await http.requests('PATCH /api/v1/markers/:id')[0].json()).toEqual({ note: 'Próximos passos' })

    await user.click(within(marker).getByRole('button', { name: 'Excluir marcador' }))
    const dialog = screen.getByRole('dialog', { name: 'Excluir o marcador?' })
    await user.click(within(dialog).getByRole('button', { name: 'Excluir marcador' }))
    await waitFor(() => expect(http.requests('DELETE /api/v1/markers/:id')).toHaveLength(1))
    expect(http.requests('DELETE /api/v1/markers/:id')[0].url).toContain('01928f3a-1c00-7a00-8000-000000000c11')
  })
})

describe('página da gravação', () => {
  it('mostra as falas com locutor e tempo, e o player do áudio', async () => {
    mockTranscriptApi()
    renderApp(`/gravacoes/${RECORDING}`)
    expect(await screen.findByRole('heading', { name: 'Alinhamento do programa de lideranças' })).toBeInTheDocument()
    await openTranscript()
    const falas = await screen.findByRole('list', { name: 'Falas' })
    const items = within(falas).getAllByRole('listitem')
    expect(items).toHaveLength(12)
    expect(within(items[0]).getByText('Mariana Couto')).toBeInTheDocument()
    expect(within(items[1]).getByText('Locutor 2')).toBeInTheDocument()
    expect(within(items[0]).getByRole('button', { name: /Ouvir a partir de 00:00:03/ })).toBeInTheDocument()
    const audio = screen.getByLabelText('Áudio da gravação') as HTMLAudioElement
    expect(audio.getAttribute('src')).toBe(`/api/v1/recordings/${RECORDING}/audio`)
  })

  it('clicar num segmento posiciona e toca o player e destaca a fala', async () => {
    mockTranscriptApi()
    renderApp(`/gravacoes/${RECORDING}`)
    await openTranscript()
    const falas = await screen.findByRole('list', { name: 'Falas' })
    const items = within(falas).getAllByRole('listitem')
    const audio = screen.getByLabelText('Áudio da gravação') as HTMLAudioElement

    await userEvent.click(items[3].querySelector('p')!)
    expect(audio.currentTime).toBe(39.5)
    expect(audio.play).toHaveBeenCalled()
    expect(segment(items[3])).toHaveAttribute('aria-current', 'true')

    await userEvent.click(within(items[6]).getByRole('button', { name: /Ouvir a partir de 00:01:20/ }))
    expect(audio.currentTime).toBe(80.9)
    expect(segment(items[6])).toHaveAttribute('aria-current', 'true')
    expect(segment(items[3])).not.toHaveAttribute('aria-current')
  })

  it('o destaque acompanha o tempo do player', async () => {
    mockTranscriptApi()
    renderApp(`/gravacoes/${RECORDING}`)
    await openTranscript()
    const falas = await screen.findByRole('list', { name: 'Falas' })
    const items = within(falas).getAllByRole('listitem')
    const audio = screen.getByLabelText('Áudio da gravação') as HTMLAudioElement
    vi.mocked(Element.prototype.scrollIntoView).mockClear()
    audio.currentTime = 100
    fireEvent.timeUpdate(audio)
    expect(segment(items[7])).toHaveAttribute('aria-current', 'true')
    // Acompanhar rola só a lista de falas: nada chama `scrollIntoView`, que rolaria a página.
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled()
  })

  it('falha passageira: o dono retenta e a gravação volta para a fila', async () => {
    const failed = fixtures.recordingQueued()
    failed.status = 'failed'
    failed.job = {
      ...failed.job!,
      state: 'failed',
      error: { code: 'worker_lost', message: 'O worker de transcrição parou no meio do job.', retryable: true },
    }
    const http = mockFetch({
      'GET /api/v1/me': () => fixtures.me(),
      'GET /api/v1/recordings/:id': () => failed,
      'POST /api/v1/recordings/:id/retranscribe': () => fixtures.recordingQueued(),
    })
    renderApp(`/gravacoes/${failed.id}`)
    expect(await screen.findByText(/A falha foi passageira/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }))
    expect(await screen.findByText(/3ª na fila/)).toBeInTheDocument()
    expect(http.requests('POST /api/v1/recordings/:id/retranscribe')).toHaveLength(1)
  })

  it('o dono cancela a transcrição em curso com confirmação, e a gravação mostra o motivo', async () => {
    const processing = fixtures.recordingQueued()
    processing.status = 'processing'
    processing.job = { ...processing.job!, state: 'running', stage: 'asr', progress: 0.4 }
    const cancelled = fixtures.recordingQueued()
    cancelled.status = 'failed'
    cancelled.job = {
      ...cancelled.job!,
      state: 'cancelled',
      error: { code: 'cancelled', message: 'Transcrição cancelada.', retryable: true },
    }
    cancelled.pipeline = cancelled.pipeline.map((step) =>
      step.step === 'transcription' ? { ...step, state: 'skipped', reason: 'cancelled' } : step,
    )
    const http = mockFetch({
      'GET /api/v1/me': () => fixtures.me(),
      'GET /api/v1/recordings/:id': () => processing,
      'POST /api/v1/recordings/:id/cancel': () => cancelled,
    })
    renderApp(`/gravacoes/${processing.id}`)
    await userEvent.click(await screen.findByRole('button', { name: 'Cancelar transcrição' }))
    const dialog = screen.getByRole('dialog', { name: 'Cancelar a transcrição?' })
    // Desistir não chama a API.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }))
    expect(http.requests('POST /api/v1/recordings/:id/cancel')).toHaveLength(0)

    await userEvent.click(screen.getByRole('button', { name: 'Cancelar transcrição' }))
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Parar a transcrição' }))
    expect(await screen.findByText('Transcrição cancelada.')).toBeInTheDocument()
    expect(http.requests('POST /api/v1/recordings/:id/cancel')).toHaveLength(1)
    expect(screen.getByText('Transcrição · pulada: a transcrição foi cancelada')).toBeInTheDocument()
    expect(screen.getByText(/Você cancelou a transcrição/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Transcrever de novo' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancelar transcrição' })).not.toBeInTheDocument()
  })

  it('gravação ainda em processamento mostra o job no lugar da transcrição', async () => {
    const page = fixtures.recordingPage()
    mockFetch({
      'GET /api/v1/me': () => fixtures.me(),
      'GET /api/v1/recordings/:id': () => page.items[0],
    })
    renderApp('/gravacoes/01928f3a-1c00-7a00-8000-000000000402')
    expect(await screen.findByText('Separando locutores')).toBeInTheDocument()
    expect(screen.getByText(/aparece aqui assim que o processamento terminar/)).toBeInTheDocument()
  })
})
