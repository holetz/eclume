// E2E of the app against the contract mock server (Prism at 127.0.0.1:4010, deploy/docker-compose.mock.yml),
// with Vite dev serving the app and proxying /api. Runs on the build host and on CI.
import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.E2E_PORT ?? 5174)

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  // `flaky-reporter` summarizes the test that only passed on retry (a warning, not a failure).
  reporter: [['list'], ['./e2e/flaky-reporter.ts']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    locale: 'pt-BR',
    // The mock fixtures are Brasília times: the library positions them by local time.
    timezoneId: 'America/Sao_Paulo',
    trace: 'retain-on-failure',
  },
  // E2E_CHANNEL=chrome uses the installed Google Chrome (CI); without it, Playwright's Chromium. The
  // Chromium runs every scenario; WebKit and Firefox only the smoke (`@smoke` in the title), with one
  // retry: they are the gauge of the other engines, not the whole suite.
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], channel: process.env.E2E_CHANNEL } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] }, grep: /@smoke/, retries: 1 },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] }, grep: /@smoke/, retries: 1 },
  ],
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    // Vite's /api proxy points at the same mock the test uses.
    env: { ECLUME_API_URL: process.env.ECLUME_MOCK_URL ?? 'http://127.0.0.1:4010' },
    timeout: 60_000,
  },
})
