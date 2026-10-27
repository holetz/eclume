import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { fixtures } from '../../test/fixtures'
import { mockTranscriptApi, openSpeakers, openTranscript, RECORDING_ID } from '../../test/transcriptApi'
import { preloadRoute, renderApp } from '../../test/render'

beforeAll(() => preloadRoute('/gravacoes/x'))

afterEach(() => vi.unstubAllGlobals())

const RAFAEL = { id: '01928f3a-1c00-7a00-8000-000000000302', name: 'Rafael Lima' }

async function openPanel() {
  renderApp(`/gravacoes/${RECORDING_ID}`)
  await openTranscript()
  return openSpeakers()
}

function linkedTo(person: { id: string; name: string } | null, label = 'Locutor 3') {
  return { ...fixtures.transcript().speakers[2], label: person ? person.name : label, person }
}

describe('linking a speaker to a person', () => {
  it('links a speaker to a person chosen in the combobox, by keyboard', async () => {
    const http = mockTranscriptApi({
      'GET /api/v1/people': (request) => {
        const q = new URL(request.url).searchParams.get('q') ?? ''
        const page = fixtures.personPage()
        return { ...page, items: page.items.filter((p) => p.name.toLowerCase().includes(q.toLowerCase())) }
      },
      'PATCH /api/v1/transcripts/:id/speakers/:speaker': () => linkedTo(RAFAEL),
    })
    const panel = await openPanel()
    await userEvent.click(within(panel).getByRole('button', { name: 'Ligar Locutor 3 a uma pessoa' }))
    const combo = within(panel).getByRole('combobox', { name: 'Pessoa para Locutor 3' })
    expect(combo).toHaveFocus()
    await userEvent.type(combo, 'raf')
    const listbox = within(panel).getByRole('listbox', { name: 'Pessoa para Locutor 3' })
    expect(await within(listbox).findByRole('option', { name: /Rafael Lima/ })).toHaveAttribute('aria-selected', 'true')
    expect(within(listbox).getAllByRole('option')).toHaveLength(2) // Rafael and "Cadastrar “raf”"
    await userEvent.keyboard('{Enter}')

    expect(await within(panel).findByRole('link', { name: 'Rafael Lima' })).toHaveAttribute('href', `/pessoas/${RAFAEL.id}`)
    const request = http.requests('PATCH /api/v1/transcripts/:id/speakers/:speaker')[0]
    expect(new URL(request.url).pathname).toMatch(/\/speakers\/S3$/)
    expect(await request.json()).toEqual({ person_id: RAFAEL.id })
    const segmentList = screen.getByRole('list', { name: 'Falas' })
    expect(within(segmentList).getAllByText('Rafael Lima')).toHaveLength(3)
  })

  it('registers the person on the spot and links', async () => {
    const created = { ...fixtures.person(), id: 'nova-pessoa', name: 'Joana Prado' }
    const http = mockTranscriptApi({
      'GET /api/v1/people': () => ({ items: [], next_cursor: null }),
      'POST /api/v1/people': () => created,
      'PATCH /api/v1/transcripts/:id/speakers/:speaker': () => linkedTo({ id: created.id, name: created.name }),
    })
    const panel = await openPanel()
    await userEvent.click(within(panel).getByRole('button', { name: 'Ligar Locutor 3 a uma pessoa' }))
    await userEvent.type(within(panel).getByRole('combobox'), 'Joana Prado')
    await userEvent.click(await within(panel).findByRole('option', { name: 'Cadastrar “Joana Prado”' }))

    expect(await within(panel).findByRole('link', { name: 'Joana Prado' })).toBeInTheDocument()
    expect(await http.requests('POST /api/v1/people')[0].json()).toEqual({ name: 'Joana Prado' })
    expect(await http.requests('PATCH /api/v1/transcripts/:id/speakers/:speaker')[0].json()).toEqual({
      person_id: 'nova-pessoa',
    })
  })

  it('unlinks the person and Esc cancels the choice', async () => {
    const transcript = fixtures.transcript()
    transcript.speakers[2] = linkedTo(RAFAEL)
    const http = mockTranscriptApi({
      'GET /api/v1/transcripts/:id': () => transcript,
      'PATCH /api/v1/transcripts/:id/speakers/:speaker': () => linkedTo(null, 'Rafael Lima'),
    })
    const panel = await openPanel()
    await userEvent.click(within(panel).getByRole('button', { name: 'Desligar Rafael Lima de Rafael Lima' }))
    expect(await within(panel).findByRole('button', { name: 'Ligar Rafael Lima a uma pessoa' })).toBeInTheDocument()
    expect(await http.requests('PATCH /api/v1/transcripts/:id/speakers/:speaker')[0].json()).toEqual({ person_id: null })

    await userEvent.click(within(panel).getByRole('button', { name: 'Ligar Rafael Lima a uma pessoa' }))
    await userEvent.keyboard('{Escape}')
    expect(within(panel).queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('accepts the voice suggestion with one click', async () => {
    const transcript = fixtures.transcript()
    transcript.speakers[1].suggestions = [{ person: RAFAEL, score: 0.82 }]
    const http = mockTranscriptApi({
      'GET /api/v1/transcripts/:id': () => transcript,
      'PATCH /api/v1/transcripts/:id/speakers/:speaker': () => fixtures.speakerLinked(),
    })
    const panel = await openPanel()
    const list = within(panel).getByRole('list', { name: 'Sugestões por voz para Locutor 2' })
    expect(list).toHaveTextContent('Parece ser Rafael Lima — 82%')
    await userEvent.click(within(panel).getByRole('button', { name: 'Aceitar Rafael Lima para Locutor 2' }))
    expect(await within(panel).findByRole('link', { name: 'Rafael Lima' })).toBeInTheDocument()
    expect(await http.requests('PATCH /api/v1/transcripts/:id/speakers/:speaker')[0].json()).toEqual({
      person_id: RAFAEL.id,
    })
  })

  it('shows the link made by voice and confirms it with one click', async () => {
    const transcript = fixtures.transcript()
    transcript.speakers[1] = { ...transcript.speakers[1], label: RAFAEL.name, person: RAFAEL, auto_score: 0.91 }
    const http = mockTranscriptApi({
      'GET /api/v1/transcripts/:id': () => transcript,
      'PATCH /api/v1/transcripts/:id/speakers/:speaker': () => ({ ...transcript.speakers[1], auto_score: null }),
    })
    const panel = await openPanel()
    expect(within(panel).getByText('Atribuído pela voz — 91%')).toBeInTheDocument()
    await userEvent.click(within(panel).getByRole('button', { name: 'Confirmar Rafael Lima para Rafael Lima' }))
    await waitFor(() => expect(within(panel).queryByText(/Atribuído pela voz/)).not.toBeInTheDocument())
    expect(await http.requests('PATCH /api/v1/transcripts/:id/speakers/:speaker')[0].json()).toEqual({
      person_id: RAFAEL.id,
    })
  })

  it('rejects a suggestion and shows the others in order', async () => {
    const transcript = fixtures.transcript()
    const JULIANA = { id: '01928f3a-1c00-7a00-8000-000000000303', name: 'Juliana Prado' }
    transcript.speakers[1].suggestions = [
      { person: RAFAEL, score: 0.82 },
      { person: JULIANA, score: 0.71 },
    ]
    const http = mockTranscriptApi({
      'GET /api/v1/transcripts/:id': () => transcript,
      'DELETE /api/v1/transcripts/:id/speakers/:speaker/suggestions/:person': () => ({
        ...transcript.speakers[1],
        suggestions: [{ person: JULIANA, score: 0.71 }],
      }),
    })
    const panel = await openPanel()
    const list = within(panel).getByRole('list', { name: 'Sugestões por voz para Locutor 2' })
    expect(within(list).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      expect.stringContaining('Rafael Lima — 82%'),
      expect.stringContaining('Juliana Prado — 71%'),
    ])
    await userEvent.click(within(panel).getByRole('button', { name: 'Recusar Rafael Lima para Locutor 2' }))
    expect(await within(panel).findByRole('button', { name: 'Aceitar Juliana Prado para Locutor 2' })).toBeInTheDocument()
    expect(within(panel).queryByText(/Rafael Lima — 82%/)).not.toBeInTheDocument()
    expect(http.requests('DELETE /api/v1/transcripts/:id/speakers/:speaker/suggestions/:person')[0].url).toContain(
      `/speakers/S2/suggestions/${RAFAEL.id}`,
    )
  })
})
