import { focusManager } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pollDelay, pollWhile } from './polling'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-01T12:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
  focusManager.setFocused(undefined)
})

const waiting = (status = 'success') => ({ queryHash: '["job"]', state: { data: { busy: true }, status } })
const interval = pollWhile<{ busy: boolean }>((data) => data?.busy ?? false, 3000)

describe('ritmo do polling', () => {
  it('fica no inicial por 2 min e depois dobra a cada minuto até 30 s', () => {
    expect(pollDelay(3000, 0)).toBe(3000)
    expect(pollDelay(3000, 119_999)).toBe(3000)
    expect(pollDelay(3000, 120_000)).toBe(6000)
    expect(pollDelay(3000, 180_000)).toBe(12_000)
    expect(pollDelay(3000, 240_000)).toBe(24_000)
    expect(pollDelay(3000, 300_000)).toBe(30_000)
    expect(pollDelay(3000, 3_600_000)).toBe(30_000)
  })

  it('conta a espera desde a primeira leitura, para no erro e quando o job termina', () => {
    expect(interval(waiting())).toBe(3000)
    vi.advanceTimersByTime(150_000)
    expect(interval(waiting())).toBe(6000)
    expect(interval(waiting('error'))).toBe(false)
    // Depois do erro, a espera recomeça do inicial.
    expect(interval(waiting())).toBe(3000)
    expect(interval({ queryHash: '["job"]', state: { data: { busy: false }, status: 'success' } })).toBe(false)
  })

  it('voltar para a aba recomeça do ritmo inicial', () => {
    expect(interval(waiting())).toBe(3000)
    vi.advanceTimersByTime(400_000)
    expect(interval(waiting())).toBe(30_000)
    focusManager.setFocused(false)
    focusManager.setFocused(true)
    expect(interval(waiting())).toBe(3000)
  })
})
