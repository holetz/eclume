// E2E do app contra o mock server do contrato (Prism em 127.0.0.1:4010, deploy/docker-compose.mock.yml),
// com o Vite dev servindo o app e fazendo proxy de /api. Roda no host de build e na CI.
import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.E2E_PORT ?? 5174)

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  // `flaky-reporter` resume o teste que só passou no retry (aviso, não falha).
  reporter: [['list'], ['./e2e/flaky-reporter.ts']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    locale: 'pt-BR',
    // As fixtures do mock são horários de Brasília: a biblioteca posiciona pela hora local.
    timezoneId: 'America/Sao_Paulo',
    trace: 'retain-on-failure',
  },
  // E2E_CHANNEL=chrome usa o Google Chrome instalado (CI); sem ele, o Chromium do Playwright. O
  // Chromium roda todos os cenários; WebKit e Firefox, só o smoke (`@smoke` no título), com uma
  // nova tentativa: são o termômetro dos outros motores, não a suíte inteira.
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], channel: process.env.E2E_CHANNEL } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] }, grep: /@smoke/, retries: 1 },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] }, grep: /@smoke/, retries: 1 },
  ],
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    // O proxy de /api do Vite aponta para o mesmo mock que o teste usa.
    env: { ECLUME_API_URL: process.env.ECLUME_MOCK_URL ?? 'http://127.0.0.1:4010' },
    timeout: 60_000,
  },
})
