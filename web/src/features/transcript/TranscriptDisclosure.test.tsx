import { act, fireEvent, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fixtures } from '../../test/fixtures'
import { renderApp } from '../../test/render'
import { mockTranscriptApi, RECORDING_ID as RECORDING } from '../../test/transcriptApi'

// Conta os renders de cada fala e da barra de marcadores, sem mudar o que renderizam.
const renders = vi.hoisted(() => ({ rows: 0, markerBar: 0 }))
vi.mock('./SegmentRow', async (original) => {
  const actual = await original<typeof import('./SegmentRow')>()
  const { memo } = await import('react')
  const Inner = (actual.SegmentRow as unknown as { type: (props: object) => ReactNode }).type
  const counted = (props: Parameters<typeof Inner>[0]) => {
    renders.rows += 1
    return Inner(props)
  }
  return { ...actual, SegmentRow: memo(counted) }
})
vi.mock('./MarkerBar', async (original) => {
  const actual = await original<typeof import('./MarkerBar')>()
  return {
    ...actual,
    MarkerBar: (props: Parameters<typeof actual.MarkerBar>[0]) => {
      renders.markerBar += 1
      return actual.MarkerBar(props)
    },
  }
})

afterEach(() => vi.unstubAllGlobals())

const COUNT = 3000
const STEP_MS = 4000

/** 3.000 falas a partir da fixture, com ids e inícios crescentes (4 s cada). */
function longTranscript() {
  const base = fixtures.transcript()
  const segments = Array.from({ length: COUNT }, (_, index) => {
    const model = base.segments[index % base.segments.length]
    return { ...model, id: `fala-${index}`, start_ms: index * STEP_MS, end_ms: index * STEP_MS + STEP_MS - 1 }
  })
  return { ...base, segments }
}

function audio() {
  return screen.getByLabelText('Áudio da gravação') as HTMLAudioElement
}

function tick(ms: number) {
  act(() => {
    audio().currentTime = ms / 1000
    fireEvent.timeUpdate(audio())
  })
}

describe('transcrição longa', () => {
  it('um tick sem troca de fala não renderiza fala nenhuma; a troca renderiza duas', async () => {
    mockTranscriptApi({ 'GET /api/v1/transcripts/:id': () => longTranscript() })
    renderApp(`/gravacoes/${RECORDING}?t=0`)
    const list = await screen.findByRole('list', { name: 'Falas' })
    expect(list.children).toHaveLength(COUNT)
    await screen.findByRole('group', { name: 'Marcadores' })

    tick(1000)
    renders.rows = 0
    renders.markerBar = 0
    tick(1500)
    tick(2000)
    expect(renders.rows).toBe(0)
    expect(renders.markerBar).toBe(0)

    tick(STEP_MS * 10 + 500)
    expect(renders.rows).toBe(2)
    expect(renders.markerBar).toBe(0)
    expect(list.children[10].querySelector('.segment')).toHaveAttribute('aria-current', 'true')
  })
})
