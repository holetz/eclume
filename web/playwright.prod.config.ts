// Proofs in the browser installed on the workstation:
// - e2e-prod/admin.spec.ts, the read-only administration panel, on production (ECLUME_PROD_URL,
//   https://192.168.15.199:8443): ECLUME_ADMIN_EMAIL and ECLUME_ADMIN_PASSWORD;
// - e2e-prod/prova.spec.ts, the user web (deploy/prove-web-prod.sh), which writes and so runs on
//   staging (ECLUME_PROOF_URL, https://127.0.0.1:18444) and refuses production: ECLUME_PROD_EMAIL and
//   ECLUME_PROD_PASSWORD.
// Each proof skips without its variables.
// The default is Google Chrome; E2E_CHANNEL=msedge uses Edge, where Chrome is not installed.
// The browser ignores the internal CA's TLS error; the real certificate is checked outside it, by the
// runbook's `curl --cacert eclume-root.crt` (docs/project/deploy-producao.md).
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e-prod',
  timeout: 2 * 60_000,
  expect: { timeout: 20_000 },
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: process.env.ECLUME_PROD_URL ?? 'https://192.168.15.199:8443',
    ignoreHTTPSErrors: true,
    locale: 'pt-BR',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chrome', use: { ...devices['Desktop Chrome'], channel: process.env.E2E_CHANNEL ?? 'chrome' } }],
})
