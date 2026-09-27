// Prova do painel de administração em produção, no navegador instalado na estação e só de leitura:
//   ECLUME_PROD_URL (https://192.168.15.199:8443), ECLUME_ADMIN_EMAIL e ECLUME_ADMIN_PASSWORD.
// O padrão é o Google Chrome; E2E_CHANNEL=msedge usa o Edge, onde o Chrome não está instalado.
// O navegador ignora o erro de TLS da CA interna; o certificado verdadeiro é conferido fora dele,
// pelo `curl --cacert eclume-root.crt` do runbook (docs/project/deploy-producao.md).
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
