import { focusManager } from '@tanstack/react-query'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { recordingState } from '../../shared/format'
import { fixtures } from '../../test/fixtures'
import { mockFetch, problem } from '../../test/http'
import { renderApp } from '../../test/render'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  focusManager.setFocused(undefined)
})

const WEEK = '/?visao=semana&data=2026-09-21'

function mockLibrary(
  recordings: (request: Request) => unknown = () => fixtures.recordingWeekPage(),
  waiting = 0,
) {
  return mockFetch({
    'GET /api/v1/me': () => fixtures.me(),
    'GET /api/v1/me/speaker-naming': () => ({ required: waiting > 0, waiting_count: waiting }),
    'GET /api/v1/recordings': recordings,
    'GET /api/v1/tags': () => fixtures.tagList(),
    'GET /api/v1/collections': () => fixtures.collectionPage(),
    'GET /api/v1/fields': () => fixtures.fieldPage(),
    'GET /api/v1/people': () => fixtures.personPage(),
  })
}

/** The library queries, without the "does the account have any?" question of the First steps card. */
function libraryQueries(http: ReturnType<typeof mockLibrary>) {
  return http
    .requests('GET /api/v1/recordings')
    .map((r) => new URL(r.url).searchParams)
    .filter((query) => query.has('from') || query.get('limit') !== '1')
}

/** The week item by the name of the link that fills it (the item carries the position and the status). */
function event(name: RegExp | string) {
  return screen.getByRole('link', { name }).closest('[role="listitem"]') as HTMLElement
}

/** Only the clock is fake: today is Saturday, 2026-09-26, 11:12. */
function saturdayMorning() {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 8, 26, 11, 12))
}

describe('library in the week', () => {
  it('reads in English when the account chose English', async () => {
    saturdayMorning()
    const me = fixtures.me()
    mockFetch({
      'GET /api/v1/me': () => ({ ...me, user: { ...me.user, locale: 'en' } }),
      'GET /api/v1/me/speaker-naming': () => ({ required: true, waiting_count: 2 }),
      'GET /api/v1/recordings': () => fixtures.recordingWeekPage(),
      'GET /api/v1/tags': () => fixtures.tagList(),
      'GET /api/v1/collections': () => fixtures.collectionPage(),
      'GET /api/v1/fields': () => fixtures.fieldPage(),
      'GET /api/v1/people': () => fixtures.personPage(),
    })
    renderApp(WEEK)

    expect(await screen.findByRole('heading', { level: 1, name: 'Library' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Import files' })).toBeInTheDocument()
    expect(screen.getByText('September 21–27, 2026')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Previous week' })).toBeInTheDocument()
    expect(screen.getByRole('radiogroup', { name: 'View' })).toHaveTextContent('MonthWeekList')
    const filters = screen.getByRole('complementary', { name: 'Filters' })
    expect(within(filters).getByRole('group', { name: 'Type' })).toHaveTextContent('MeetingsNotes')
    expect(await screen.findByText(/2 recordings are waiting for you to name the speakers/)).toBeInTheDocument()
  })

  it('shows the requested week, with header, bar and the recordings on their day and time', async () => {
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

    // Two overlapping meetings on Thursday split the column.
    expect(event(/^Revisão trimestral/).style.getPropertyValue('--lanes')).toBe('2')
    expect(event(/^1:1 Bruno \/ Carla/).style.getPropertyValue('--lane')).toBe('1')
    expect(event(/^Onboarding/).style.getPropertyValue('--lanes')).toBe('1')

    // Today (Saturday) marked, with the now line in its column.
    const heads = document.querySelectorAll('.cal-head[aria-current="date"]')
    expect(heads).toHaveLength(1)
    expect(heads[0]).toHaveTextContent('sáb26')
    const saturday = screen.getByRole('list', { name: 'sábado, 26 de setembro' })
    expect(saturday.querySelector('.cal-now')).not.toBeNull()
    expect(document.querySelectorAll('.cal-now')).toHaveLength(1)

    // The whole day in the grid, with a label also at the closing midnight.
    const hours = document.querySelectorAll('.cal-hours span')
    expect(hours).toHaveLength(25)
    expect(hours[0]).toHaveTextContent('00:00')
    expect(hours[24]).toHaveTextContent('24:00')
    // The working hours (8–18) highlighted.
    const work = [...document.querySelectorAll('.cal-hours span[data-work]')].map((span) => span.textContent)
    expect(work).toEqual(['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00'])
    expect((document.querySelector('.cal-week') as HTMLElement).style.getPropertyValue('--cal-start')).toBe('0')

    const query = libraryQueries(http)[0]
    expect(query.get('from')).toBe('2026-09-21T03:00:00.000Z')
    expect(query.get('to')).toBe('2026-09-28T03:00:00.000Z')
    expect(query.get('sort')).toBe('recorded_asc')
  })

  it('moves between weeks and back to today', async () => {
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

  it('zooms the week through the buttons and Ctrl + wheel, without going past the whole day on screen', async () => {
    saturdayMorning()
    mockLibrary()
    renderApp(WEEK)
    await screen.findByRole('list', { name: 'segunda, 21 de setembro' })
    const user = userEvent.setup()
    const week = document.querySelector('.cal-week') as HTMLElement
    const hourPx = () => parseFloat(week.style.getPropertyValue('--cal-hour'))
    const zoomOut = screen.getByRole('button', { name: 'Diminuir o zoom' })

    // It opens framing the working band (8–18): more than the whole day fits.
    const initial = hourPx()
    await user.click(screen.getByRole('button', { name: 'Aumentar o zoom' }))
    expect(hourPx()).toBeGreaterThan(initial)

    fireEvent.wheel(week, { deltaY: 100, ctrlKey: true })
    expect(hourPx()).toBeCloseTo(initial)
    // The wheel without Ctrl only scrolls.
    fireEvent.wheel(week, { deltaY: 100 })
    expect(hourPx()).toBeCloseTo(initial)

    // The minimum is the whole day in the week height: from there the zoom-out button turns off.
    for (let i = 0; i < 10 && !(zoomOut as HTMLButtonElement).disabled; i++) await user.click(zoomOut)
    expect(zoomOut).toBeDisabled()
    expect(hourPx() * 24).toBeCloseTo(initial * 10)
  })

  it('follows the working hours and the opening view chosen on the Environment screen', async () => {
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

  it('shows the loading, the error with retry and the empty period', async () => {
    let fail = true
    // The first response waits for the test to check the loading: without it, the error arrives first.
    let answer = () => {}
    const held = new Promise<void>((resolve) => (answer = resolve))
    mockLibrary(async (request) => {
      if (fail) {
        await held
        return problem('internal', 500, { detail: 'O servidor não respondeu.' })
      }
      // Nothing this week, but the account has recordings.
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

  it('an account without recordings invites to import, to install the apps and to review the agenda types', async () => {
    const http = mockLibrary(() => ({ items: [], next_cursor: null }))
    renderApp(WEEK)
    const heading = await screen.findByRole('heading', { name: 'Nenhuma gravação ainda' })
    const empty = heading.closest('.card') as HTMLElement
    expect(within(empty).getByRole('link', { name: 'app desktop' })).toHaveAttribute('href', '/app-desktop')
    expect(within(empty).getByRole('link', { name: 'app do celular' })).toHaveAttribute('href', '/app-movel')
    expect(within(empty).getByRole('link', { name: 'tipo de agenda' })).toHaveAttribute('href', '/config/agendas')
    expect(within(empty).getByRole('button', { name: 'Importar arquivos' })).toBeInTheDocument()
    expect(document.querySelector('.cal-week')).toBeNull()
    // The "any?" question goes without a period and without a filter.
    const any = http.requests('GET /api/v1/recordings').map((r) => new URL(r.url).searchParams)
    expect(any.some((query) => query.get('limit') === '1' && !query.has('from'))).toBe(true)
  })
})

describe('re-read on focus', () => {
  it('returning to the tab re-reads the recordings of the period', async () => {
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

describe('library filters and restore', () => {
  const COLLECTION = '01928f3a-1c00-7a00-8000-000000000801'
  const LAST = `eclume-biblioteca-ultima:${fixtures.me().user.id}`
  const VIEW_LABELS: Record<string, string> = { semana: 'Semana', mes: 'Mês', lista: 'Lista' }

  /** The query of the last recordings request of the period (the one the screen shows now). */
  function lastRangeQuery(http: ReturnType<typeof mockLibrary>) {
    const ranges = http.requests('GET /api/v1/recordings').filter((r) => new URL(r.url).searchParams.has('from'))
    return new URL(ranges.at(-1)!.url).searchParams
  }

  it('restores the last library once and lets the collection be unchecked', async () => {
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
    // The URL stays as the filter left it: neither does the collection come back, nor is the view changed.
    expect(screen.getByRole('radio', { name: 'Semana' })).toBeChecked()
    expect(screen.getByText('21–27 de setembro de 2026')).toBeInTheDocument()
    expect(localStorage.getItem(LAST)).toBe('visao=semana&data=2026-09-21')
  })

  it('the last library is per account: another account\'s and the old global key do not come back', async () => {
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
    // The stored one is only written after the chosen opening reached the URL.
    await waitFor(() => expect(localStorage.getItem(LAST)).toBe(`visao=${opening}`))
    await userEvent.click(tag)
    await waitFor(() => expect(tag).toHaveAttribute('aria-pressed', 'true'))
    // Time for a restore effect, if one still existed, to overwrite the URL.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(tag).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('radio', { name: VIEW_LABELS[opening] })).toBeChecked()
    expect(localStorage.getItem(LAST)).toBe(`visao=${opening}&tag=cliente-metalurgica`)
  })

  it('removing the last filter, leaving the URL empty, clears the stored last library', async () => {
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

describe('incremental re-read with a recording in progress', () => {
  it('reads only what changed through ?since= and writes it to the cache, without re-reading the whole period', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date(2026, 8, 26, 11, 12))
    const page = fixtures.recordingWeekPage()
    const busy = page.items.find((item) => recordingState(item).state === 'busy')!
    const finished = { ...fixtures.recordingTranscribed(), id: busy.id, title: 'Já terminou', recorded_at: busy.recorded_at }
    const http = mockLibrary((request) =>
      new URL(request.url).searchParams.has('since') ? { items: [finished], next_cursor: null } : page,
    )
    renderApp(WEEK)
    await screen.findByText('21–27 de setembro de 2026')
    const ranged = () => http.requests('GET /api/v1/recordings').filter((r) => new URL(r.url).searchParams.has('from'))
    await waitFor(() => expect(ranged()).toHaveLength(1))

    await act(() => vi.advanceTimersByTimeAsync(3_000))
    await waitFor(() => expect(ranged()).toHaveLength(2))
    const incremental = new URL(ranged()[1].url).searchParams
    expect(incremental.get('since')).toMatch(/^2026-/)
    expect(incremental.get('sort')).toBe('recorded_asc')
    expect(await screen.findByRole('link', { name: /Já terminou/ })).toBeInTheDocument()

    // Nothing in progress anymore: no new reads.
    await act(() => vi.advanceTimersByTimeAsync(60_000))
    expect(ranged()).toHaveLength(2)
  })
})

describe('library in the month and the list', () => {
  it('shows the month with up to three recordings per day, and the day opens the week', async () => {
    saturdayMorning()
    const page = fixtures.recordingWeekPage()
    // Two more on the 24th (Thursday): four on the day, three visible and "+1".
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

    const query = libraryQueries(http)[0]
    expect(query.get('from')).toBe('2026-08-31T03:00:00.000Z')
    expect(query.get('to')).toBe('2026-10-05T03:00:00.000Z')

    await userEvent.click(within(thursday).getByRole('button', { name: 'Abrir a semana de quinta, 24 de setembro' }))
    expect(await screen.findByText('21–27 de setembro de 2026')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Semana' })).toBeChecked()
  })

  it('moves month by month', async () => {
    mockLibrary()
    renderApp('/?visao=mes&data=2026-09-21')
    await screen.findByText('Setembro de 2026')
    await userEvent.click(screen.getByRole('button', { name: 'Próximo mês' }))
    expect(await screen.findByText('Outubro de 2026')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Mês anterior' }))
    await userEvent.click(screen.getByRole('button', { name: 'Mês anterior' }))
    expect(await screen.findByText('Agosto de 2026')).toBeInTheDocument()
  })

  it('lists by day, newest first, with the status and Carregar mais', async () => {
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

    const query = libraryQueries(http)[0]
    expect(query.get('sort')).toBe('recorded_desc')
    expect(query.get('limit')).toBe('50')
    expect(query.has('from')).toBe(false)
  })

  it('tells how many recordings need you and Ver turns the filter on in the list', async () => {
    const http = mockLibrary(() => fixtures.recordingWeekPage(), 2)
    renderApp(WEEK)
    const band = await screen.findByRole('status', { name: 'Precisam de você' })
    expect(band).toHaveTextContent('2 gravações aguardam você nomear os locutores')
    await userEvent.click(within(band).getByRole('button', { name: 'Ver' }))
    await waitFor(() =>
      expect(libraryQueries(http).some((query) => query.getAll('awaiting').includes('speakers'))).toBe(true),
    )
    expect(screen.queryByRole('status', { name: 'Precisam de você' })).not.toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Aguardando locutores' })).toBeChecked()
  })

  it('with no recording waiting, no notice', async () => {
    mockLibrary()
    renderApp(WEEK)
    await screen.findByRole('button', { name: 'Próxima semana' })
    expect(screen.queryByRole('status', { name: 'Precisam de você' })).not.toBeInTheDocument()
  })

  it('on a narrow screen, with no view in the URL, opens in the list', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(max-width: 56rem)' }))
    mockLibrary()
    renderApp('/')
    expect(await screen.findByRole('radio', { name: 'Lista' })).toBeChecked()
    expect(await screen.findAllByRole('region')).not.toHaveLength(0)
  })
})
