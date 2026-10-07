// Registra o teste que só passou no retry: o job continua verde, mas o resumo ao fim da execução
// (e, na CI, um `::warning::` por teste) deixa a instabilidade visível.
import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter'

export function tituloFlaky(projeto: string | undefined, caminho: string[]): string {
  return `[${projeto ?? '?'}] ${caminho.slice(1).join(' > ')}`
}

export default class FlakyReporter implements Reporter {
  private flaky = new Map<string, number>()

  onTestEnd(test: TestCase, result: TestResult): void {
    if (result.status === 'passed' && result.retry > 0) {
      this.flaky.set(tituloFlaky(test.parent.project()?.name, test.titlePath()), result.retry)
    }
  }

  onEnd(): void {
    if (this.flaky.size === 0) return
    console.log(`\nTestes flaky (só passaram no retry): ${this.flaky.size}`)
    for (const [titulo, retry] of this.flaky) {
      console.log(`  flaky: ${titulo} (passou na tentativa ${retry + 1})`)
      if (process.env.CI) console.log(`::warning title=Teste flaky::${titulo}`)
    }
  }

  printsToStdio(): boolean {
    return false
  }
}
