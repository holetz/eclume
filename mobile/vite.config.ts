import react from '@vitejs/plugin-react'
import { configDefaults, defineConfig } from 'vitest/config'

// O Tauri serve o `dist/` no WebView; em dev (`tauri android dev`), o emulador acessa o Vite pela
// porta fixa 1420 no endereço que o CLI passa em TAURI_DEV_HOST.
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
