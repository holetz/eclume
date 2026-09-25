// Testes de navegador da biblioteca de conversão: Chrome headless (canal `chrome`, que tem os
// decoders proprietários como AAC), rodados no host de build por `remote-run`.
import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  optimizeDeps: { exclude: ['@ffmpeg/ffmpeg'] },
  test: {
    include: ['src/**/*.browser.test.ts'],
    testTimeout: 120_000,
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({ launchOptions: { channel: 'chrome' } }),
      instances: [{ browser: 'chromium' }],
    },
  },
})
