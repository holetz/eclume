// Serves desktop/ui from inside the test and injects the simulated Tauri. Any request that leaves
// the app (a CDN font, an external script) is aborted and recorded in `externalRequests`.
import { test as base, expect, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const UI = path.resolve(here, '../ui')
export const ORIGIN = 'http://eclume.test'

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
}

type Fixtures = {
  externalRequests: string[]
  open: (scenario?: string) => Promise<Page>
}

export const test = base.extend<Fixtures>({
  externalRequests: async ({}, use) => {
    await use([])
  },
  open: async ({ page, externalRequests }, use) => {
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url())
      if (url.origin !== ORIGIN) {
        externalRequests.push(url.href)
        return route.abort()
      }
      const file = path.join(UI, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname))
      try {
        const body = await readFile(file)
        return route.fulfill({ body: body, contentType: CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream' })
      } catch {
        return route.fulfill({ status: 404, body: 'not found' })
      }
    })
    await use(async (scenario = 'idle') => {
      await page.addInitScript((name) => {
        ;(window as unknown as { __MOCK_SCENARIO: string }).__MOCK_SCENARIO = name
      }, scenario)
      await page.addInitScript({ path: path.join(here, 'mock-tauri.js') })
      await page.goto(`${ORIGIN}/index.html`)
      return page
    })
  },
})

/** The calls to the simulated Tauri, in order. */
export async function calls(page: Page): Promise<{ command: string; args: unknown }[]> {
  return page.evaluate(() => (window as unknown as { __mock: { calls: never[] } }).__mock.calls)
}

export { expect }
