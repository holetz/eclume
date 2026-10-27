import { screen, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { preloadRoute, renderApp } from '../../test/render'
import { mockTranscriptApi, openSpeakers, openTranscript, RECORDING_ID } from '../../test/transcriptApi'

beforeAll(() => preloadRoute('/gravacoes/x'))

afterEach(() => vi.unstubAllGlobals())

/** The `details` of the Locutores block, found by the start of its summary. */
async function speakersBlock() {
  const summary = await screen.findByText(
    (_, element) => element?.tagName === 'SUMMARY' && Boolean(element.textContent?.startsWith('Locutores')),
  )
  return summary.closest('details') as HTMLDetailsElement
}

describe('Locutores block', () => {
  it('collapsed, shows the speakers inline, each in its color, before the transcript', async () => {
    mockTranscriptApi()
    renderApp(`/gravacoes/${RECORDING_ID}`)
    const block = await speakersBlock()
    expect(block).toHaveClass('disclosure')
    expect(block.open).toBe(false)
    const summary = block.querySelector('summary')!
    const names = [...summary.querySelectorAll('.speaker')].map((chip) => chip.textContent)
    expect(names).toEqual(['Mariana Couto', 'Locutor 2', 'Locutor 3'])
    expect(within(summary).getByText('Mariana Couto')).toHaveClass('speaker', 'speaker-1')
    expect(screen.queryByRole('region', { name: 'Locutores' })).not.toBeInTheDocument()

    // It sits before the transcript, outside it.
    const transcript = [...document.querySelectorAll('details.disclosure')].find((element) =>
      element.querySelector('summary')?.textContent?.startsWith('Transcrição'),
    )!
    expect(block.compareDocumentPosition(transcript) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(transcript.contains(block)).toBe(false)
  })

  it('open, swaps the line for one card per speaker in a grid, with each one\'s actions', async () => {
    mockTranscriptApi()
    renderApp(`/gravacoes/${RECORDING_ID}`)
    const region = await openSpeakers()
    const block = await speakersBlock()
    expect(block.open).toBe(true)
    expect(block.querySelector('summary .speaker')).toBeNull()

    // The cards are the children of the grid's list (the voice suggestions are lists inside them).
    const cards = [...region.querySelector('ul')!.children] as HTMLElement[]
    expect(cards).toHaveLength(3)
    expect(within(cards[1]).getByRole('button', { name: 'Renomear Locutor 2' })).toBeInTheDocument()
    expect(within(cards[2]).getByRole('button', { name: 'Ligar Locutor 3 a uma pessoa' })).toBeInTheDocument()
    expect(within(region).getByRole('button', { name: 'Mesclar locutores' })).toBeInTheDocument()
  })

  it('opening the transcript does not bring the speakers, and the fields panel does not repeat them', async () => {
    mockTranscriptApi()
    renderApp(`/gravacoes/${RECORDING_ID}`)
    await openTranscript()
    expect(await screen.findByRole('list', { name: 'Falas' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Locutores' })).not.toBeInTheDocument()
    const fields = await screen.findByRole('region', { name: 'Campos' })
    expect(within(fields).queryByRole('group', { name: 'Locutores' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Corrigir locutores' })).not.toBeInTheDocument()
  })
})
