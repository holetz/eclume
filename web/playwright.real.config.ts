// App E2E against the real backend: an ephemeral stack (deploy/docker-compose.e2e.yml, project
// eclume-e2e) started by deploy/e2e-real.sh on the host, which passes the URL and the disposable admin:
//   ECLUME_E2E_URL, ECLUME_E2E_ADMIN_EMAIL, ECLUME_E2E_ADMIN_PASSWORD and ECLUME_E2E_AUDIO (speech WAV).
// The certificate is the ephemeral Caddy's internal CA: the browser ignores the TLS error.
// e2e-real/producao.spec.ts picks its own target: staging (ECLUME_PROOF_URL, default
// https://127.0.0.1:18444, deploy/staging.sh up), never production.
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e-real',
  // Transcription on the CPU with the model download on the first run, and the summary through `claude -p`.
  timeout: 8 * 60_000,
  expect: { timeout: 20_000 },
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: process.env.ECLUME_E2E_URL ?? 'https://127.0.0.1:18443',
    ignoreHTTPSErrors: true,
    locale: 'pt-BR',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chrome', use: { ...devices['Desktop Chrome'], channel: process.env.E2E_CHANNEL ?? 'chrome' } }],
})
