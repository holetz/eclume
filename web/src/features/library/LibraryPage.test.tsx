import { focusManager } from '@tanstack/react-query'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fixtures } from '../../test/fixtures'
import { mockFetch, problem } from '../../test/http'
import { renderApp } from '../../test/render'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  focusManager.setFocused(undefined)
})

const WEEK = '/?visao=semana&data=2026-09-21'

function mockLibrary(recordings: (request: Request) => unknown = () => fixtures.recordingWeekPage()) {
  return mockFetch({
    'GET /api/v1/me': () => fixtures.me(),
    'GET /api/v1/recordings': recordings,
    'GET /api/v1/tags': () => fixtures.tagList(),
    'GET /api/v1/collections': () => fixtures.collectionPage(),
    'GET /api/v1/fields': () => fixtures.fieldPage(),
    'GET /api/v1/people': () => fixtures.personPage(),
  })
}

/** O item da semana pelo nome do link que o ocupa (o item leva a posição e o estado). */
function event(name: RegExp | string) {
  return screen.getByRole('link', { name }).closest('[role="listitem"]') as HTMLElement
}

/** Só o relógio é falso: hoje é sábado, 26/09/2026, 11:12. */
function saturdayMorning() {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 8, 26, 11, 12))
}

describe('biblioteca na semana', () => {
  it('mostra a semana pedida, com cabeçalho, barra e as gravações no dia e na hora', async () => {
    saturdayMorning()
    const http = mockLibrary()
    renderApp(WEEK)

    expect(await screen.findByRole('heading', { level: 1, name: 'Biblioteca' })).toBeInTheDocument()
    expect(screen.getByText('Gravações', { selector: '.kicker' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Buscar' })).toHaveAttribute('href', '/busca')
    expect(screen.getByText('21–27 de setembro de 2026')).toHaveClass('toolbar-title')
    expect(screen.getByRole('radio', { name: 'Semana' })).toBeChecked()

    const monday = await screen.findByRole('list', { name: 'segunda, 21 de setembro' })
    await waitFor(() => expect(within(monday).getAllByRole('listitem')).toHaveLength(2))
    const planning = event(/^Planejamento semanal/)
    const link = within(planning).getByRole('link')
    expect(link).toHaveAccessibleName('Planejamento semanal, 09:00, 58 min, 2 marcadores')
    expect(link).toHaveAttribute('href', '/gravacoes/01928f3a-1c00-7a00-8000-0000000004a1')
    expect(planning).toHaveClass('cal-event')
    expect(planning.style.getPropertyValue('--s')).toBe('9')
    expect(within(planning).getByText('09:00 · 58 min')).toHaveClass('mono')
    expect(within(planning).getByText('2')).toHaveClass('marker-count')
    expect(event(/^Círculo de liderança/)).toHaveTextContent('10:30 · 1 h 40')

    const note = event(/^Nota · Ligação do fornecedor/)
    expect(note).toHaveAttribute('data-kind', 'note')
    expect(note.querySelector('.mono')).toBeNull()
    expect(note.style.getPropertyValue('--s')).toBe('8.3')

    const failed = event(/^reuniao-03\.mkv/)
    expect(failed).toHaveAttribute('data-status', 'failed')
    expect(within(failed).getByText('Falhou')).toBeInTheDocument()

    const summarizing = event('1:1 Elisa / Ana, 10:30, 39 min, Resumindo, 1 marcador')
    expect(summarizing).toHaveAttribute('data-status', 'processing')
    expect(within(summarizing).getByText('Resumindo')).toBeInTheDocument()

    // Duas reuniões sobrepostas na quinta dividem a coluna.
    expect(event(/^Revisão trimestral/).style.getPropertyValue('--lanes')).toBe('2')
    expect(event(/^1:1 Bruno \/ Carla/).style.getPropertyValue('--lane')).toBe('1')
    expect(event(/^Onboarding/).style.getPropertyValue('--lanes')).toBe('1')

    // Hoje (sábado) marcado, com a linha de agora na coluna dele.
    const heads = document.querySelectorAll('.cal-head[aria-current="date"]')
    expect(heads).toHaveLength(1)
    expect(heads[0]).toHaveTextContent('sáb26')
    const saturday = screen.getByRole('list', { name: 'sábado, 26 de setembro' })
    expect(saturday.querySelector('.cal-now')).not.toBeNull()
    expect(document.querySelectorAll('.cal-now')).toHaveLength(1)

    // O dia inteiro na grade, com rótulo também na meia-noite do fim.
    const hours = document.querySelectorAll('.cal-hours span')
    expect(hours).toHaveLength(25)
    expect(hours[0]).toHaveTextContent('00:00')
    expect(hours[24]).toHaveTextContent('24:00')
    // O expediente (8–18) destacado.
    const work = [...document.querySelectorAll('.cal-hours span[data-work]')].map((span) => span.textContent)
    expect(work).toEqual(['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00'])
    expect((document.querySelector('.cal-week') as HTMLElement).style.getPropertyValue('--cal-start')).toBe('0')

    const query = new URL(http.requests('GET /api/v1/recordings')[0].url).searchParams
    expect(query.get('from')).toBe('2026-09-21T03:00:00.000Z')
    expect(query.get('to')).toBe('2026-09-28T03:00:00.000Z')
    expect(query.get('sort')).toBe('recorded_asc')
  })

  it('anda entre as semanas e volta para hoje', async () => {
    saturdayMorning()
    const http = mockLibrary()
    renderApp(WEEK)
    await screen.findByText('21–27 de setembro de 2026')
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: 'Próxima semana' }))
    expect(await screen.findByText('28 de setembro – 4 de outubro de 2026')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Semana anterior' }))
    await user.click(screen.getByRole('button', { name: 'Semana anterior' }))
    expect(await screen.findByText('14–20 de setembro de 2026')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Hoje' }))
    expect(await screen.findByText('21–27 de setembro de 2026')).toBeInTheDocument()

    const froms = http.requests('GET /api/v1/recordings').map((r) => new URL(r.url).searchParams.get('from'))
    expect(froms).toContain('2026-09-28T03:00:00.000Z')
    expect(froms).toContain('2026-09-14T03:00:00.000Z')
  })

  it('dá zoom na semana pelos botões e por Ctrl + roda, sem passar do dia inteiro na tela', async () => {
    saturdayMorning()
    mockLibrary()
    renderApp(WEEK)
    await screen.findByRole('list', { name: 'segunda, 21 de setembro' })
    const user = userEvent.setup()
    const week = document.querySelector('.cal-week') as HTMLElement
    const hourPx = () => parseFloat(week.style.getPropertyValue('--cal-hour'))
    const zoomOut = screen.getByRole('button', { name: 'Diminuir o zoom' })

    // Abre enquadrando a faixa de trabalho (8–18): cabe mais que o dia inteiro.
    const initial = hourPx()
    await user.click(screen.getByRole('button', { name: 'Aumentar o zoom' }))
    expect(hourPx()).toBeGreaterThan(initial)

    fireEvent.wheel(week, { deltaY: 100, ctrlKey: true })
    expect(hourPx()).toBeCloseTo(initial)
    // A roda sem Ctrl só rola.
    fireEvent.wheel(week, { deltaY: 100 })
    expect(hourPx()).toBeCloseTo(initial)

    // O mínimo é o dia inteiro na altura da semana: dali o botão de diminuir desliga.
    for (let i = 0; i < 10 && !(zoomOut as HTMLButtonElement).disabled; i++) await user.click(zoomOut)
    expect(zoomOut).toBeDisabled()
    expect(hourPx() * 24).toBeCloseTo(initial * 10)
  })

  it('segue o expediente e a visão de abertura escolhidos na tela Ambiente', async () => {
    saturdayMorning()
    mockLibrary()
    localStorage.setItem('eclume-expediente', '7-20')
    localStorage.setItem('eclume-biblioteca-abertura', 'semana')
    localStorage.setItem(`eclume-biblioteca-ultima:${fixtures.me().user.id}`, 'visao=lista')
    renderApp('/')

    expect(await screen.findByRole('radio', { name: 'Semana' })).toBeChecked()
    await screen.findByRole('list', { name: 'segunda, 21 de setembro' })
    const work = [...document.querySelectorAll('.cal-hours span[data-work]')].map((span) => span.textContent)
    expect(work[0]).toBe('07:00')
    expect(work.at(-1)).toBe('20:00')
  })

  it('mostra o carregamento, o erro com nova tentativa e o período vazio', async () => {
    let fail = true
    // A primeira resposta espera o teste conferir o carregamento: sem isso, o erro chega antes.
    let answer = () => {}
    const held = new Promise<void>((resolve) => (answer = resolve))
    mockLibrary(async (request) => {
      if (fail) {
        await held
        return problem('internal', 500, { detail: 'O servidor não respondeu.' })
      }
      // Nada nesta semana, mas a conta tem gravações.
      return new URL(request.url).searchParams.has('from') ? { items: [], next_cursor: null } : fixtures.recordingPage()
    })
    renderApp(WEEK)
    expect(await screen.findByText('Carregando gravações…')).toHaveAttribute('role', 'status')
    expect(document.querySelector('.cal-week')).toHaveAttribute('aria-busy', 'true')
    answer()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('O servidor não respondeu.')
    fail = false
    await userEvent.click(within(alert).getByRole('button', { name: 'Tentar de novo' }))
    expect(await screen.findByText('Nada gravado neste período.')).toBeInTheDocument()
    expect(document.querySelector('.cal-week')).not.toBeNull()
  })

  it('conta sem gravações convida a importar e a instalar o app', async () => {
    const http = mockLibrary(() => ({ items: [], next_cursor: null }))
    renderApp(WEEK)
    expect(await screen.findByRole('heading', { name: 'Nenhuma gravação ainda' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'app desktop' })).toHaveAttribute('href', '/app-desktop')
    expect(document.querySelector('.cal-week')).toBeNull()
    // A pergunta "tem alguma?" vai sem período e sem filtro.
    const any = http.requests('GET /api/v1/recordings').map((r) => new URL(r.url).searchParams)
    expect(any.some((query) => query.get('limit') === '1' && !query.has('from'))).toBe(true)
  })
})

describe('releitura no foco', () => {
  it('voltar para a aba relê as gravações do período', async () => {
    saturdayMorning()
    const http = mockLibrary()
    renderApp(WEEK)
    await screen.findByText('21–27 de setembro de 2026')
    const ranged = () => http.requests('GET /api/v1/recordings').filter((r) => new URL(r.url).searchParams.has('from'))
    await waitFor(() => expect(ranged()).toHaveLength(1))

    act(() => focusManager.setFocused(false))
    vi.setSystemTime(new Date(2026, 8, 26, 11, 13))
    act(() => focusManager.setFocused(true))
    await waitFor(() => expect(ranged()).toHaveLength(2))
  })
})

describe('filtros e restauração da biblioteca', () => {
  const COLLECTION = '01928f3a-1c00-7a00-8000-000000000801'
  const LAST = `eclume-biblioteca-ultima:${fixtures.me().user.id}`
  const VIEW_LABELS: Record<string, string> = { semana: 'Semana', mes: 'Mês', lista: 'Lista' }

  /** A query da última requisição de gravações do período (a que a tela mostra agora). */
  function lastRangeQuery(http: ReturnType<typeof mockLibrary>) {
    const ranges = http.requests('GET /api/v1/recordings').filter((r) => new URL(r.url).searchParams.has('from'))
    return new URL(ranges.at(-1)!.url).searchParams
  }

  it('restaura a última biblioteca uma vez e deixa desmarcar a coleção', async () => {
    saturdayMorning()
    const http = mockLibrary()
    localStorage.setItem(LAST, `visao=semana&data=2026-09-21&colecao=${COLLECTION}`)
    renderApp('/')

    const collection = await screen.findByRole('checkbox', { name: 'Metalúrgica Serra Azul' })
    await waitFor(() => expect(collection).toBeChecked())
    await waitFor(() => expect(lastRangeQuery(http).getAll('collection')).toEqual([COLLECTION]))

    await userEvent.click(collection)
    await waitFor(() => expect(collection).not.toBeChecked())
    await waitFor(() => expect(lastRangeQuery(http).has('collection')).toBe(false))
    // A URL fica como o filtro a deixou: nem a coleção volta, nem a visão é trocada.
    expect(screen.getByRole('radio', { name: 'Semana' })).toBeChecked()
    expect(screen.getByText('21–27 de setembro de 2026')).toBeInTheDocument()
    expect(localStorage.getItem(LAST)).toBe('visao=semana&data=2026-09-21')
  })

  it('a última biblioteca é por conta: a de outra conta e a chave global antiga não voltam', async () => {
    saturdayMorning()
    mockLibrary()
    localStorage.setItem('eclume-biblioteca-ultima', `colecao=${COLLECTION}`)
    localStorage.setItem('eclume-biblioteca-ultima:outra-conta', 'visao=lista')
    renderApp('/')

    expect(await screen.findByRole('checkbox', { name: 'Metalúrgica Serra Azul' })).not.toBeChecked()
    expect(screen.getByRole('radio', { name: 'Semana' })).toBeChecked()
    expect(localStorage.getItem('eclume-biblioteca-ultima')).toBeNull()
    expect(localStorage.getItem('eclume-biblioteca-ultima:outra-conta')).toBe('visao=lista')
    expect(localStorage.getItem(LAST)).toBeNull()
  })

  it.each(['semana', 'mes', 'lista'])('com a abertura "%s", marcar uma tag mantém a tag', async (opening) => {
    saturdayMorning()
    mockLibrary()
    localStorage.setItem('eclume-biblioteca-abertura', opening)
    renderApp('/')

    const tag = await screen.findByRole('button', { name: 'cliente-metalurgica' })
    // A guardada só é gravada depois que a abertura escolhida chegou à URL.
    await waitFor(() => expect(localStorage.getItem(LAST)).toBe(`visao=${opening}`))
    await userEvent.click(tag)
    await waitFor(() => expect(tag).toHaveAttribute('aria-pressed', 'true'))
    // Dá tempo de um efeito de restauração, se ainda houvesse, sobrescrever a URL.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(tag).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('radio', { name: VIEW_LABELS[opening] })).toBeChecked()
    expect(localStorage.getItem(LAST)).toBe(`visao=${opening}&tag=cliente-metalurgica`)
  })

  it('tirar o último filtro, deixando a URL vazia, limpa a última biblioteca guardada', async () => {
    mockLibrary()
    renderApp('/?tag=cliente-metalurgica')

    const tag = await screen.findByRole('button', { name: 'cliente-metalurgica' })
    await waitFor(() => expect(tag).toHaveAttribute('aria-pressed', 'true'))
    expect(localStorage.getItem(LAST)).toBe('tag=cliente-metalurgica')

    await userEvent.click(tag)
    await waitFor(() => expect(tag).toHaveAttribute('aria-pressed', 'false'))
    await waitFor(() => expect(localStorage.getItem(LAST)).toBeNull())
  })
})

describe('biblioteca no mês e na lista', () => {
  it('mostra o mês com até três gravações por dia, e o dia abre a semana', async () => {
    saturdayMorning()
    const page = fixtures.recordingWeekPage()
    // Mais duas no dia 24 (quinta): quatro no dia, três visíveis e "+1".
    page.items.push(
      { ...page.items[6], id: '01928f3a-1c00-7a00-8000-0000000004b1', title: 'Extra 1' },
      { ...page.items[6], id: '01928f3a-1c00-7a00-8000-0000000004b2', title: 'Extra 2' },
    )
    const http = mockLibrary(() => page)
    renderApp('/?visao=mes&data=2026-09-21')

    expect(await screen.findByText('Setembro de 2026')).toHaveClass('toolbar-title')
    expect(screen.getByRole('radio', { name: 'Mês' })).toBeChecked()
    expect(document.querySelectorAll('.cal-dow')).toHaveLength(7)
    expect(document.querySelectorAll('.cal-cell')).toHaveLength(35)
    expect(document.querySelectorAll('.cal-cell[data-outside]')).toHaveLength(5)
    expect(screen.getByRole('group', { name: 'sábado, 26 de setembro' })).toHaveAttribute('aria-current', 'date')

    const tuesday = await screen.findByRole('group', { name: 'terça, 22 de setembro' })
    await waitFor(() => expect(within(tuesday).getAllByRole('link')).toHaveLength(2))
    expect(within(tuesday).getByRole('link', { name: 'Nota · Rascunho da pauta' })).toHaveClass('cal-dot')
    const thursday = screen.getByRole('group', { name: 'quinta, 24 de setembro' })
    expect(within(thursday).getAllByRole('link')).toHaveLength(3)
    expect(within(thursday).getByText('+1')).toBeInTheDocument()

    const query = new URL(http.requests('GET /api/v1/recordings')[0].url).searchParams
    expect(query.get('from')).toBe('2026-08-31T03:00:00.000Z')
    expect(query.get('to')).toBe('2026-10-05T03:00:00.000Z')

    await userEvent.click(within(thursday).getByRole('button', { name: 'Abrir a semana de quinta, 24 de setembro' }))
    expect(await screen.findByText('21–27 de setembro de 2026')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Semana' })).toBeChecked()
  })

  it('anda de mês em mês', async () => {
    mockLibrary()
    renderApp('/?visao=mes&data=2026-09-21')
    await screen.findByText('Setembro de 2026')
    await userEvent.click(screen.getByRole('button', { name: 'Próximo mês' }))
    expect(await screen.findByText('Outubro de 2026')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Mês anterior' }))
    await userEvent.click(screen.getByRole('button', { name: 'Mês anterior' }))
    expect(await screen.findByText('Agosto de 2026')).toBeInTheDocument()
  })

  it('lista por dia, da mais recente, com o estado e Carregar mais', async () => {
    saturdayMorning()
    const recent = fixtures.recordingWeekPage()
    recent.items.reverse()
    const first = { items: recent.items.slice(0, 6), next_cursor: 'c2' }
    const second = { items: recent.items.slice(6), next_cursor: null }
    const http = mockLibrary((request) => (new URL(request.url).searchParams.get('cursor') === 'c2' ? second : first))
    renderApp('/?visao=lista')

    const today = await screen.findByRole('region', { name: 'Hoje · sáb 26 set' })
    expect(within(today).getByText('1 item')).toBeInTheDocument()
    const row = within(today).getByRole('link', { name: /1:1 Elisa \/ Ana/ })
    expect(row).toHaveClass('rec-row')
    expect(row).toHaveTextContent('10:30')
    expect(row).toHaveTextContent('· 39 min')
    expect(within(row).getByText('Resumindo')).toHaveClass('badge-progress')
    expect(screen.queryByRole('button', { name: 'Próxima semana' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Hoje' })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Carregar mais' }))
    const monday = await screen.findByRole('region', { name: 'seg 21 set' })
    expect(within(monday).getByText('2 itens')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Carregar mais' })).not.toBeInTheDocument()

    const query = new URL(http.requests('GET /api/v1/recordings')[0].url).searchParams
    expect(query.get('sort')).toBe('recorded_desc')
    expect(query.get('limit')).toBe('50')
    expect(query.has('from')).toBe(false)
  })

  it('em tela estreita, sem visão na URL, abre na lista', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(max-width: 56rem)' }))
    mockLibrary()
    renderApp('/')
    expect(await screen.findByRole('radio', { name: 'Lista' })).toBeChecked()
    expect(await screen.findAllByRole('region')).not.toHaveLength(0)
  })
})
