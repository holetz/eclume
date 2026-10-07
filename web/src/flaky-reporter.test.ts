// Teste do reporter de flaky do Playwright (web/e2e/flaky-reporter.ts): só o que passa no retry entra.
import type { TestCase, TestResult } from '@playwright/test/reporter'
import { afterEach, describe, expect, it, vi } from 'vitest'

import FlakyReporter, { tituloFlaky } from '../e2e/flaky-reporter'

const caso = (projeto: string, caminho: string[]) =>
  ({ parent: { project: () => ({ name: projeto }) }, titlePath: () => caminho }) as unknown as TestCase
const resultado = (status: string, retry: number) => ({ status, retry }) as unknown as TestResult

describe('FlakyReporter', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('lista o teste que falhou na 1a tentativa e passou na 2a', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const r = new FlakyReporter()
    r.onTestEnd(caso('chromium', ['', 'app.spec.ts', 'login']), resultado('passed', 1))
    r.onTestEnd(caso('chromium', ['', 'app.spec.ts', 'estavel']), resultado('passed', 0))
    r.onEnd()
    const saida = log.mock.calls.map((c) => String(c[0])).join('\n')
    expect(saida).toContain('flaky: [chromium] app.spec.ts > login')
    expect(saida).not.toContain('estavel')
  })

  it('emite ::warning:: na CI e fica mudo sem flaky', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.stubEnv('CI', '1')
    const r = new FlakyReporter()
    r.onEnd()
    expect(log).not.toHaveBeenCalled()
    r.onTestEnd(caso('webkit', ['', 'a.spec.ts', 't']), resultado('passed', 1))
    r.onEnd()
    expect(log.mock.calls.some((c) => String(c[0]).startsWith('::warning title=Teste flaky::[webkit]'))).toBe(true)
  })

  it('o título ignora a raiz do caminho', () => {
    expect(tituloFlaky('firefox', ['', 'x.spec.ts', 'a', 'b'])).toBe('[firefox] x.spec.ts > a > b')
  })
})
