// Serve desktop/ui de dentro do teste e injeta o Tauri simulado. Qualquer requisição que saia do
// app (fonte de CDN, script externo) é abortada e registrada em `externas`.
import { test as base, expect, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const aqui = path.dirname(fileURLToPath(import.meta.url))
const UI = path.resolve(aqui, '../ui')
export const ORIGEM = 'http://eclume.test'

const TIPOS: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
}

type Fixtures = {
  externas: string[]
  abrir: (cenario?: string) => Promise<Page>
}

export const test = base.extend<Fixtures>({
  externas: async ({}, use) => {
    await use([])
  },
  abrir: async ({ page, externas }, use) => {
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url())
      if (url.origin !== ORIGEM) {
        externas.push(url.href)
        return route.abort()
      }
      const arquivo = path.join(UI, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname))
      try {
        const corpo = await readFile(arquivo)
        return route.fulfill({ body: corpo, contentType: TIPOS[path.extname(arquivo)] ?? 'application/octet-stream' })
      } catch {
        return route.fulfill({ status: 404, body: 'não encontrado' })
      }
    })
    await use(async (cenario = 'ocioso') => {
      await page.addInitScript((nome) => {
        ;(window as unknown as { __MOCK_CENARIO: string }).__MOCK_CENARIO = nome
      }, cenario)
      await page.addInitScript({ path: path.join(aqui, 'mock-tauri.js') })
      await page.goto(`${ORIGEM}/index.html`)
      return page
    })
  },
})

/** As chamadas ao Tauri simulado, na ordem. */
export async function chamadas(page: Page): Promise<{ comando: string; args: unknown }[]> {
  return page.evaluate(() => (window as unknown as { __mock: { chamadas: never[] } }).__mock.chamadas)
}

export { expect }
