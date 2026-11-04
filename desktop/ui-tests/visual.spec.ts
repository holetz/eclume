// Visual checks: each view at both window sizes (520 × 600, the default, and 380 × 420, the
// smallest useful size) and both themes. Check app fonts, no external requests, no
// horizontal scrolling, square DS corners and the record button in --color-rec; save screenshots
// under captures/<view>-<size>-<theme>.png for review.
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'

const SCREENSHOTS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'captures')

const SIZES = [
  { name: '520x600', width: 520, height: 600 },
  { name: '380x420', width: 380, height: 420 },
]

const THEMES = [
  { name: 'light', scheme: 'light' },
  { name: 'dark', scheme: 'dark' },
] as const

type View = { name: string; scenario: string; ready: string; go?: (page: Page) => Promise<void> }

const tab = (name) => async (page: Page) => {
  await page.keyboard.press('Control+,')
  await page.locator(`[data-tab="${name}"]`).click()
}

const VIEWS = [
  { name: 'home', scenario: 'queue', ready: '#queue li' },
  { name: 'recording', scenario: 'markers', ready: '#count-markers' },
  { name: 'note', scenario: 'note', ready: '#note-silence' },
  { name: 'updated', scenario: 'updated', ready: '#updated' },
  { name: 'first-run', scenario: 'firstRun', ready: '#first-run-servers .choice' },
  {
    name: 'first-run-check',
    scenario: 'firstRun',
    ready: '#first-run-trust',
    go: async (page) => page.locator('#first-run-servers .choice').nth(1).click(),
  },
  {
    name: 'import',
    scenario: 'idle',
    ready: '#import-file',
    go: async (page) => {
      await page.keyboard.press('Control+o')
      await page.locator('#import-choose').click()
    },
  },
  { name: 'settings-general', scenario: 'idle', ready: '#theme .seg-opt', go: tab('general') },
  { name: 'settings-meetings', scenario: 'idle', ready: '#apps .list-row', go: tab('meetings') },
  { name: 'settings-audio', scenario: 'idle', ready: '#shortcuts .list-row', go: tab('audio') },
  { name: 'settings-storage', scenario: 'idle', ready: '#space-used:not(:empty)', go: tab('storage') },
  { name: 'settings-folder', scenario: 'idle', ready: '#folder-rules li', go: tab('folder') },
  { name: 'settings-server', scenario: 'idle', ready: '#server-account:not(:empty)', go: tab('server') },
  {
    name: 'shortcuts',
    scenario: 'idle',
    ready: '#shortcuts-global dt',
    go: async (page) => page.keyboard.press('Control+/'),
  },
  {
    name: 'help-menu',
    scenario: 'idle',
    ready: '#menu-help:not([hidden])',
    go: async (page) => page.locator('#open-help').click(),
  },
]

/** Selectors for DS components that must have square corners (--radius-* tokens are 0). */
const SQUARE = '.btn, .input, .alert, .choice, .badge, .code-block, .seg, .seg-opt, .tab, .menu, .list, .dropzone, .queue li'

for (const view of VIEWS) {
  for (const size of SIZES) {
    for (const theme of THEMES) {
      test(`${view.name} · ${size.name} · ${theme.name}`, async ({ open, externalRequests, page }) => {
        await page.setViewportSize({ width: size.width, height: size.height })
        await page.emulateMedia({ colorScheme: theme.scheme })
        await open(view.scenario)
        // First run skips home: it is already the ready view.
        if (view.scenario !== 'firstRun') {
          await expect(page.locator('#line-status')).not.toHaveText('Carregando…')
        }
        await view.go?.(page)
        await expect(page.locator(view.ready).first()).toBeVisible()
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme.scheme)

        const measurement = await page.evaluate(async (square) => {
          await document.fonts.ready
          const visible = [...document.querySelectorAll<HTMLElement>(square)].filter((e) => e.offsetParent !== null)
          const color = (value) => {
            const probe = document.createElement('i')
            probe.style.color = value
            document.body.append(probe)
            const resolved = getComputedStyle(probe).color
            probe.remove()
            return resolved
          }
          const record = document.querySelector<HTMLElement>('[data-view]:not([hidden]) .btn-rec')
          return {
            families: [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replaceAll('"', '')),
            scroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            rounded: visible
              .filter((e) => getComputedStyle(e).borderRadius !== '0px')
              .map((e) => `${e.tagName.toLowerCase()}#${e.id}.${e.className}`),
            record: record && {
              color: getComputedStyle(record).backgroundColor,
              expected: color('var(--color-rec)'),
              pressed: record.getAttribute('aria-pressed'),
            },
          }
        }, SQUARE)

        expect(measurement.families).toContain('Archivo')
        expect(measurement.scroll, 'rolagem horizontal').toBeLessThanOrEqual(0)
        expect(measurement.rounded).toEqual([])
        if (measurement.record && measurement.record.pressed === 'false') {
          expect(measurement.record.color).toBe(measurement.record.expected)
        }
        await mkdir(SCREENSHOTS, { recursive: true })
        await page.screenshot({ path: path.join(SCREENSHOTS, `${view.name}-${size.name}-${theme.name}.png`), fullPage: true })
        expect(externalRequests).toEqual([])
      })
    }
  }
}

test("the chosen theme overrides the system and follows it again under System", async ({ open, page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await open()
  await page.locator('#open-settings').click()
  await expect(page.locator('input[name="theme"][value="system"]')).toBeChecked()
  await page.locator('#theme .seg-opt', { hasText: 'Escuro' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  // The next state poll does not undo the choice, nor does a system theme change override it.
  await page.waitForTimeout(1_200)
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.locator('#theme .seg-opt', { hasText: 'Claro' }).click()
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.locator('#theme .seg-opt', { hasText: 'Sistema' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
})
