// Test of the Playwright flaky reporter (web/e2e/flaky-reporter.ts): only what passes on retry gets in.
import type { TestCase, TestResult } from '@playwright/test/reporter'
import { afterEach, describe, expect, it, vi } from 'vitest'

import FlakyReporter, { flakyTitle } from '../e2e/flaky-reporter'

const testCase = (project: string, path: string[]) =>
  ({ parent: { project: () => ({ name: project }) }, titlePath: () => path }) as unknown as TestCase
const result = (status: string, retry: number) => ({ status, retry }) as unknown as TestResult

describe('FlakyReporter', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('lists the test that failed on the 1st attempt and passed on the 2nd', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const r = new FlakyReporter()
    r.onTestEnd(testCase('chromium', ['', 'app.spec.ts', 'login']), result('passed', 1))
    r.onTestEnd(testCase('chromium', ['', 'app.spec.ts', 'stable']), result('passed', 0))
    r.onEnd()
    const output = log.mock.calls.map((c) => String(c[0])).join('\n')
    expect(output).toContain('flaky: [chromium] app.spec.ts > login')
    expect(output).not.toContain('stable')
  })

  it('emits ::warning:: on CI and stays silent without flaky tests', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.stubEnv('CI', '1')
    const r = new FlakyReporter()
    r.onEnd()
    expect(log).not.toHaveBeenCalled()
    r.onTestEnd(testCase('webkit', ['', 'a.spec.ts', 't']), result('passed', 1))
    r.onEnd()
    expect(log.mock.calls.some((c) => String(c[0]).startsWith('::warning title=Flaky test::[webkit]'))).toBe(true)
  })

  it('the title ignores the root of the path', () => {
    expect(flakyTitle('firefox', ['', 'x.spec.ts', 'a', 'b'])).toBe('[firefox] x.spec.ts > a > b')
  })
})
