import react from '@vitejs/plugin-react'
import { configDefaults, defineConfig } from 'vitest/config'

// Tauri serves `dist/` in the WebView; in dev (`tauri android dev`), the emulator reaches Vite on
// the fixed port 1420 at the address the CLI passes in TAURI_DEV_HOST.
const host = process.env.TAURI_DEV_HOST

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: { ignored: ['**/src-tauri/**', '**/crates/**', '**/plugins/**'] },
  },
  build: { target: 'es2022' },
  test: {
    environment: 'jsdom',
    setupFiles: ['./ui/src/test-setup.ts'],
    exclude: [...configDefaults.exclude, 'e2e/**', 'src-tauri/**', 'plugins/**'],
  },
})
