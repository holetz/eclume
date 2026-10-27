// Records the test that only passed on retry: the job stays green, but the summary at the end of the
// run (and, on CI, one `::warning::` per test) keeps the instability visible.
import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter'

export function flakyTitle(project: string | undefined, path: string[]): string {
  return `[${project ?? '?'}] ${path.slice(1).join(' > ')}`
}

export default class FlakyReporter implements Reporter {
  private flaky = new Map<string, number>()

  onTestEnd(test: TestCase, result: TestResult): void {
    if (result.status === 'passed' && result.retry > 0) {
      this.flaky.set(flakyTitle(test.parent.project()?.name, test.titlePath()), result.retry)
    }
  }

  onEnd(): void {
    if (this.flaky.size === 0) return
    console.log(`\nFlaky tests (passed only on retry): ${this.flaky.size}`)
    for (const [title, retry] of this.flaky) {
      console.log(`  flaky: ${title} (passed on attempt ${retry + 1})`)
      if (process.env.CI) console.log(`::warning title=Flaky test::${title}`)
    }
  }

  printsToStdio(): boolean {
    return false
  }
}
