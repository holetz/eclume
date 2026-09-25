import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  // O @ffmpeg/ffmpeg cria o próprio worker por URL relativa; o pré-bundle do Vite a quebraria.
  optimizeDeps: { exclude: ['@ffmpeg/ffmpeg'] },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
  },
})
