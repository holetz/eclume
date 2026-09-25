import react from '@vitejs/plugin-react'
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  // O @ffmpeg/ffmpeg cria o próprio worker por URL relativa; o pré-bundle do Vite a quebraria.
  optimizeDeps: { exclude: ['@ffmpeg/ffmpeg'] },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    // Os testes de navegador rodam só por `npm run test:browser` (vitest.browser.config.ts).
    exclude: [...configDefaults.exclude, '**/*.browser.test.ts'],
  },
})
