// Testes da UI do desktop (desktop/ui) num Chromium, com o Tauri simulado por mock-tauri.js. A UI
// é servida pelo próprio teste (page.route em fixtures.ts), sem servidor nem build.
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
