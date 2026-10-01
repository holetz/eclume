import { describe, expect, it } from 'vitest'
import { dayKey, dayLabel, eventBox, lanes, monthGrid, monthTitle, parseDayKey, weekRange, weekTitle } from './calendar'
import { shortDayLabel } from '../../shared/format'

// Os testes rodam em America/Sao_Paulo (vite.config.ts), como as fixtures do mock.
const local = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min)

describe('semana e mês', () => {
  it('vai de segunda 00:00 à segunda seguinte, de qualquer dia da semana', () => {
    for (const day of [local(2026, 9, 21), local(2026, 9, 24, 15), local(2026, 9, 27, 23, 59)]) {
      const week = weekRange(day)
      expect(week.from).toEqual(local(2026, 9, 21))
      expect(week.to).toEqual(local(2026, 9, 28))
      expect(week.days.map(dayKey)).toEqual([
        '2026-09-21',
        '2026-09-22',
        '2026-09-23',
        '2026-09-24',
        '2026-09-25',
        '2026-09-26',
        '2026-09-27',
      ])
    }
    expect(weekRange(local(2026, 9, 21)).from.toISOString()).toBe('2026-09-21T03:00:00.000Z')
  })

  it('monta a grade do mês de segunda a domingo, com os dias de fora marcados', () => {
    const september = monthGrid(local(2026, 9, 15))
    expect(september.cells).toHaveLength(35)
    expect(dayKey(september.from)).toBe('2026-08-31')
    expect(dayKey(september.to)).toBe('2026-10-05')
    expect(september.cells[0].outside).toBe(true)
    expect(september.cells[1]).toEqual({ date: local(2026, 9, 1), outside: false })
    expect(september.cells.at(-1)).toEqual({ date: local(2026, 10, 4), outside: true })

    // Agosto de 2026 começa num sábado e precisa de seis semanas.
    expect(monthGrid(local(2026, 8, 1)).cells).toHaveLength(42)
    // Fevereiro de 2027 começa numa segunda e termina num domingo: quatro semanas, sem dias de fora.
    const february = monthGrid(local(2027, 2, 10))
    expect(february.cells).toHaveLength(28)
    expect(february.cells.some((cell) => cell.outside)).toBe(false)
  })

  it('escreve os períodos e os dias em pt-BR', () => {
    expect(weekTitle(local(2026, 9, 21))).toBe('21–27 de setembro de 2026')
    expect(weekTitle(local(2026, 9, 28))).toBe('28 de setembro – 4 de outubro de 2026')
    expect(weekTitle(local(2026, 12, 28))).toBe('28 de dezembro de 2026 – 3 de janeiro de 2027')
    expect(monthTitle(local(2026, 9, 26))).toBe('Setembro de 2026')
    expect(dayLabel(local(2026, 9, 21))).toBe('segunda, 21 de setembro')
    expect(shortDayLabel(local(2026, 9, 26))).toBe('sáb 26 set')
  })

  it('lê e escreve o dia da URL', () => {
    expect(parseDayKey('2026-09-21')).toEqual(local(2026, 9, 21))
    expect(parseDayKey('2026-02-30')).toBeNull()
    expect(parseDayKey('21/09/2026')).toBeNull()
    expect(parseDayKey(null)).toBeNull()
  })
})

describe('posição na agenda', () => {
  it('posiciona pelo início local e dimensiona pela duração', () => {
    expect(eventBox({ recorded_at: '2026-09-21T12:00:00Z', duration_ms: 3_480_000, kind: 'meeting' })).toEqual({
      s: 9,
      d: 0.9666666666666667,
    })
    expect(eventBox({ recorded_at: '2026-09-22T13:30:00Z', duration_ms: 6_000_000, kind: 'meeting' }).s).toBe(10.5)
  })

  it('dá a altura mínima à nota e à duração nula, e corta na meia-noite', () => {
    expect(eventBox({ recorded_at: '2026-09-23T11:18:00Z', duration_ms: 54_000, kind: 'note' })).toEqual({ s: 8.3, d: 0.1 })
    expect(eventBox({ recorded_at: '2026-09-23T11:18:00Z', duration_ms: null, kind: 'meeting' }).d).toBe(0.1)
    expect(eventBox({ recorded_at: '2026-09-24T02:00:00Z', duration_ms: 7_200_000, kind: 'meeting' })).toEqual({
      s: 23,
      d: 1,
    })
  })


  it('divide em faixas os eventos que se sobrepõem, e só eles', () => {
    const result = lanes([
      { s: 9, d: 1.2, id: 'a' },
      { s: 9.75, d: 0.8, id: 'b' },
      { s: 15, d: 0.8, id: 'c' },
      { s: 9.9, d: 0.2, id: 'd' },
    ])
    const byId = Object.fromEntries(result.map((item) => [item.id, [item.lane, item.lanes]]))
    expect(byId).toEqual({ a: [0, 3], b: [1, 3], d: [2, 3], c: [0, 1] })

    // Um evento que começa quando o outro termina não se sobrepõe.
    const touching = lanes([
      { s: 9, d: 1 },
      { s: 10, d: 1 },
    ])
    expect(touching.map((item) => [item.lane, item.lanes])).toEqual([
      [0, 1],
      [0, 1],
    ])
  })
})
