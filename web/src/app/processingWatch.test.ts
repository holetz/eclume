import { act, renderHook } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Schemas } from '../api/client'
import { fixtures } from '../test/fixtures'
import { mockFetch } from '../test/http'
import {
  outcomeOf,
  outcomeText,
  startWatermark,
  takeOutcomes,
  useProcessingWatch,
  WATCH_MS,
  type Ended,
} from './processingWatch'
import { saveNotifyOutcomes } from './preferences'
import { setTitleCount, usePageTitle } from './usePageTitle'

type Recording = Schemas['Recording']
type Step = Schemas['PipelineStep']

const T = '2026-10-01T12:00:00Z'

function recording(id: string, status: Recording['status'], summary?: [Step['state'], string | null, string]): Recording {
  const base = fixtures.recordingTranscribed()
  const pipeline: Step[] = summary
    ? [
        {
          step: 'summary',
          state: summary[0],
          started_at: null,
          finished_at: summary[0] === 'active' || summary[0] === 'pending' ? null : summary[2],
          duration_ms: null,
          error: null,
          reason: summary[1],
        },
      ]
    : []
  return { ...base, id, title: `Reunião ${id}`, status, job: null, pipeline, updated_at: summary?.[2] ?? base.updated_at }
}

function failedJob(id: string, state: Schemas['Job']['state'], at: string): Recording {
  const base = recording(id, 'failed')
  return { ...base, updated_at: at, job: { ...fixtures.recordingTranscribed().job!, state, finished_at: at } }
}

const outcome = (rec: Recording) => {
  const ended = outcomeOf(rec)
  return ended && [ended.outcome, ended.reason]
}

describe('desfecho (os mesmos casos de desktop/crates/sync/src/outcome.rs)', () => {
  it('os quatro desfechos e os que não avisam', () => {
    expect(outcome(recording('a', 'transcribed', ['done', null, T]))).toEqual(['summary_ready', null])
    expect(outcome(recording('b', 'transcribed', ['failed', null, T]))).toEqual(['summary_failed', null])
    expect(outcome(recording('c', 'transcribed', ['skipped', 'no_provider', T]))).toEqual(['no_summary', 'no_provider'])
    expect(outcome(failedJob('d', 'failed', T))).toEqual(['transcription_failed', null])
    // Cancelar, apagar o resumo durante a geração e a gravação em curso não avisam.
    expect(outcome(failedJob('e', 'cancelled', T))).toBeNull()
    expect(outcome(recording('f', 'transcribed', ['skipped', 'summary_deleted', T]))).toBeNull()
    expect(outcome(recording('g', 'transcribed', ['skipped', 'cancelled', T]))).toBeNull()
    expect(outcome(recording('h', 'processing', ['active', null, T]))).toBeNull()
    expect(outcome(recording('i', 'processing'))).toBeNull()
  })

  it('a gravação parada à espera dos nomes dos locutores avisa uma vez', () => {
    const base = recording('j', 'transcribed')
    const waiting: Recording = {
      ...base,
      pipeline: [
        {
          step: 'speakers',
          state: 'waiting',
          started_at: T,
          finished_at: T,
          duration_ms: 0,
          error: null,
          reason: 'unnamed_speakers',
        },
      ],
    }
    expect(outcome(waiting)).toEqual(['awaiting_speakers', 'unnamed_speakers'])
    const mark = startWatermark(new Date('2026-10-01T11:59:30Z'))
    expect(takeOutcomes(mark, [waiting])).toHaveLength(1)
    expect(takeOutcomes(mark, [waiting])).toEqual([])
    // Solta (concluída), não é mais desfecho da espera.
    expect(outcome({ ...waiting, pipeline: [{ ...waiting.pipeline[0], state: 'done', reason: null }] })).toBeNull()
  })

  it("marca d'água avisa uma vez e nada anterior", () => {
    const mark = startWatermark(new Date(T))
    expect(mark.since).toBe('2026-10-01T11:59:00.000Z')
    const old = recording('velho', 'transcribed', ['done', null, '2026-10-01T11:00:00Z'])
    const fresh = recording('novo', 'transcribed', ['failed', null, '2026-10-01T12:00:05Z'])
    expect(takeOutcomes(mark, [old, fresh]).map((e) => e.recordingId)).toEqual(['novo'])
    // Reaparecer (título editado) não repete o aviso.
    expect(takeOutcomes(mark, [fresh])).toEqual([])
    // Um desfecho que confirma atrasado, dentro da folga, ainda avisa.
    expect(takeOutcomes(mark, [recording('atrasado', 'transcribed', ['done', null, '2026-10-01T12:00:02Z'])])).toHaveLength(1)
    // O resumo refeito depois é outro desfecho.
    expect(takeOutcomes(mark, [recording('novo', 'transcribed', ['done', null, '2026-10-01T12:30:00Z'])])).toHaveLength(1)
    expect(mark.since).toBe('2026-10-01T12:29:00.000Z')
    expect(mark.mark).toBe('2026-10-01T12:29:00.000Z')
    expect(takeOutcomes(mark, [fresh])).toEqual([])
  })

  it('textos dos avisos', () => {
    const text = (e: Partial<Ended>) => {
      const { title, body } = outcomeText({ recordingId: 'r', title: 'Kickoff', reason: null, at: T, outcome: 'summary_ready', ...e })
      return `${title} · ${body}`
    }
    expect(text({})).toBe('Resumo pronto · Kickoff')
    expect(text({ outcome: 'summary_failed' })).toBe('O resumo falhou · Kickoff · abra para gerar de novo')
    expect(text({ outcome: 'no_summary', reason: 'no_provider' })).toBe(
      'Pronta sem resumo · Kickoff · nenhum agente configurado; fale com quem administra',
    )
    expect(text({ outcome: 'no_summary', title: ' ', reason: 'motivo_novo' })).toBe('Pronta sem resumo · Gravação · motivo_novo')
    expect(text({ outcome: 'transcription_failed' })).toBe('A transcrição falhou · Kickoff · abra para ver o motivo')
    expect(text({ outcome: 'awaiting_speakers', reason: 'unnamed_speakers' })).toBe(
      'Precisa de você · Kickoff · nomeie os locutores para seguir com o resumo',
    )
  })
})

describe('observador na aba', () => {
  let hidden = false
  const shown: { title: string; options?: NotificationOptions; onclick: (() => void) | null }[] = []

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    vi.setSystemTime(new Date(T))
    hidden = false
    shown.length = 0
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
    class FakeNotification {
      static permission: NotificationPermission = 'granted'
      onclick: (() => void) | null = null
      constructor(title: string, options?: NotificationOptions) {
        shown.push(Object.assign(this, { title, options }) as never)
      }
      close() {}
    }
    vi.stubGlobal('Notification', FakeNotification)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    saveNotifyOutcomes(false)
    setTitleCount(0)
  })

  function watch(pages: Recording[][]) {
    const http = mockFetch({ 'GET /api/v1/recordings': () => ({ items: pages.shift() ?? [], next_cursor: null }) })
    const wrapper = ({ children }: { children: ReactNode }) => createElement(MemoryRouter, null, children)
    const hook = renderHook(
      () => {
        usePageTitle('Biblioteca')
        useProcessingWatch()
      },
      { wrapper },
    )
    return { http, hook }
  }

  const tick = () => act(async () => void (await vi.advanceTimersByTimeAsync(WATCH_MS)))

  it('conta no título com a aba oculta, zera ao voltar e só notifica com o aviso ligado', async () => {
    const ready = recording('r1', 'transcribed', ['done', null, '2026-10-01T12:00:10Z'])
    const failed = failedJob('r2', 'failed', '2026-10-01T12:00:20Z')
    const { http } = watch([[ready], [failed]])
    expect(document.title).toBe('Biblioteca · eclume')

    hidden = true
    await tick()
    expect(new URL(http.calls[0].url).searchParams.get('since')).toBe('2026-10-01T11:59:00.000Z')
    expect(document.title).toBe('(1) Biblioteca · eclume')
    expect(shown).toHaveLength(0)

    saveNotifyOutcomes(true)
    await tick()
    expect(document.title).toBe('(2) Biblioteca · eclume')
    expect(shown.map((n) => [n.title, n.options?.tag])).toEqual([['A transcrição falhou', 'r2']])

    hidden = false
    act(() => void document.dispatchEvent(new Event('visibilitychange')))
    expect(document.title).toBe('Biblioteca · eclume')
  })

  it('sem permissão do navegador, nada de notificação mesmo ligado', async () => {
    saveNotifyOutcomes(true)
    ;(Notification as unknown as { permission: string }).permission = 'denied'
    watch([[recording('r1', 'transcribed', ['done', null, '2026-10-01T12:00:10Z'])]])
    await tick()
    expect(shown).toHaveLength(0)
  })
})
