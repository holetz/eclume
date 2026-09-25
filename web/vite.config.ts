import react from '@vitejs/plugin-react'
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  // O @ffmpeg/ffmpeg cria o próprio worker por URL relativa; o pré-bundle do Vite a quebraria.
  optimizeDeps: { exclude: ['@ffmpeg/ffmpeg'] },
  server: {
    // Origem única: em dev, /api vai para o backend ou, por padrão, para o mock (Prism).
    proxy: { '/api': process.env.ECLUME_API_URL ?? 'http://127.0.0.1:4010' },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    // Os testes de navegador rodam só por `npm run test:browser` (vitest.browser.config.ts).
    exclude: [...configDefaults.exclude, '**/*.browser.test.ts', 'e2e/**', 'e2e-real/**'],
  },
})
