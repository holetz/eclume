// E2E do app contra o backend real: um stack efêmero (deploy/docker-compose.e2e.yml, projeto
// eclume-e2e) subido por deploy/e2e-real.sh no host, que passa a URL e o admin descartável:
//   ECLUME_E2E_URL, ECLUME_E2E_ADMIN_EMAIL, ECLUME_E2E_ADMIN_PASSWORD e ECLUME_E2E_AUDIO (WAV de fala).
// O certificado é o da CA interna do Caddy efêmero: o navegador ignora o erro de TLS.
// e2e-real/producao.spec.ts escolhe o próprio alvo: o staging (ECLUME_PROVA_URL, padrão
// https://127.0.0.1:18444, deploy/staging.sh subir), nunca a produção.
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e-real',
  // Transcrição na CPU com o download do modelo na primeira rodada, e o resumo pelo `claude -p`.
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
