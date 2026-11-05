// Desktop UI tests (desktop/ui) in Chromium, with Tauri simulated by mock-tauri.js. The test itself
// serves the UI (page.route in fixtures.ts), with no server and no build.
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 520, height: 600 },
    locale: 'pt-BR',
    trace: 'retain-on-failure',
  },
})
