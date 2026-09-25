import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fixtures } from '../../test/fixtures'
import { mockTranscriptApi, RECORDING_ID } from '../../test/transcriptApi'
import { renderApp } from '../../test/render'

afterEach(() => vi.unstubAllGlobals())

const RAFAEL = { id: '01928f3a-1c00-7a00-8000-000000000302', name: 'Rafael Lima' }

async function openPanel() {
  renderApp(`/gravacoes/${RECORDING_ID}`)
  return screen.findByRole('region', { name: 'Locutores' })
}

function linkedTo(person: { id: string; name: string } | null, label = 'Locutor 3') {
  return { ...fixtures.transcript().speakers[2], label: person ? person.name : label, person }
}

describe('vínculo de locutor com pessoa', () => {
  it('liga um locutor a uma pessoa escolhida no combobox, pelo teclado', async () => {
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
    expect(within(listbox).getAllByRole('option')).toHaveLength(2) // Rafael e "Cadastrar “raf”"
    await userEvent.keyboard('{Enter}')

    expect(await within(panel).findByRole('link', { name: 'Rafael Lima' })).toHaveAttribute('href', `/pessoas/${RAFAEL.id}`)
    const request = http.requests('PATCH /api/v1/transcripts/:id/speakers/:speaker')[0]
    expect(new URL(request.url).pathname).toMatch(/\/speakers\/S3$/)
    expect(await request.json()).toEqual({ person_id: RAFAEL.id })
    const falas = screen.getByRole('list', { name: 'Falas' })
    expect(within(falas).getAllByText('Rafael Lima')).toHaveLength(3)
  })

  it('cadastra a pessoa na hora e liga', async () => {
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

  it('desliga a pessoa e Esc cancela a escolha', async () => {
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

  it('confirma a sugestão por voz com um clique', async () => {
    const transcript = fixtures.transcript()
    transcript.speakers[1].suggestions = [{ person: RAFAEL, score: 0.82 }]
    const http = mockTranscriptApi({
      'GET /api/v1/transcripts/:id': () => transcript,
      'PATCH /api/v1/transcripts/:id/speakers/:speaker': () => fixtures.speakerLinked(),
    })
    const panel = await openPanel()
    expect(within(panel).getByText('Sugestão por voz: Rafael Lima (82%)')).toBeInTheDocument()
    await userEvent.click(within(panel).getByRole('button', { name: 'Confirmar Rafael Lima' }))
    expect(await within(panel).findByRole('link', { name: 'Rafael Lima' })).toBeInTheDocument()
    expect(await http.requests('PATCH /api/v1/transcripts/:id/speakers/:speaker')[0].json()).toEqual({
      person_id: RAFAEL.id,
    })
  })
})
