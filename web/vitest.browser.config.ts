// Testes de navegador (a biblioteca de conversão e o tempo de commit da transcrição longa) em três
// motores headless, rodados no host de build por `remote-run` ou pelo pilar `web-browser` do gate.
import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  optimizeDeps: { exclude: ['@ffmpeg/ffmpeg'] },
  test: {
    include: ['src/**/*.browser.test.{ts,tsx}'],
    testTimeout: 120_000,
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      // O Chromium pelo Google Chrome (canal `chrome`, com os decoders proprietários); Firefox e
      // WebKit pelos navegadores do Playwright. O que um motor não decodifica é pulado com o motivo.
      instances: [
        { browser: 'chromium', provider: playwright({ launchOptions: { channel: 'chrome' } }) },
        { browser: 'firefox' },
        { browser: 'webkit' },
      ],
    },
  },
})
