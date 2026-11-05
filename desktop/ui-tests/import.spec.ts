import { test, expect, calls } from './fixtures'
import type { Page } from '@playwright/test'

type Mock = {
  state: { importing: Record<string, unknown> }
  emit: (event, payload?: unknown) => void
}

async function adjust(page: Page, fields) {
  await page.evaluate((c) => {
    Object.assign((window as unknown as { __mock: Mock }).__mock.state.importing, c)
  }, fields)
}

async function request(page: Page) {
  return page.evaluate(() => (window as unknown as { __mock: Mock }).__mock.state.importing.request)
}

test("Import file opens the system picker and shows the name, duration and date read from the file", async ({ open }) => {
  const page = await open()
  await page.locator('#import').click()
  await expect(page.locator('[data-view="import"]')).toBeVisible()
  expect((await calls(page)).map((c) => c.command)).toContain('pick_import_file')
  await expect(page.locator('[data-view="home"]')).toBeHidden()
  await expect(page.locator('#import-name')).toHaveText('kickoff-guion.m4a · 47:12')
  await expect(page.locator('#import-date')).toHaveValue('2026-09-19T14:02')
  await expect(page.locator('#import-origin')).toHaveText('Gravado em · lida do arquivo. Mude se estiver errada.')

  await page.locator('#import-confirm').click()
  await expect(page.locator('[data-view="home"]')).toBeVisible()
  const done = (await request(page)) as { path: string; recordedAt: number; recordedAtSource: string }
  expect(done.path).toBe('/home/ana/kickoff-guion.m4a')
  expect(done.recordedAtSource).toBe('file_metadata')
  expect(done.recordedAt).toBe(new Date(2026, 8, 19, 14, 2).getTime())
})

test("a dropped file opens import; a changed date is sent as user", async ({ open }) => {
  const page = await open()
  await adjust(page, { hold: true })
  await page.evaluate(() => (window as unknown as { __mock: Mock }).__mock.emit('import-dropped', '/home/ana/gravador.wav'))
  await expect(page.locator('[data-view="import"]')).toBeVisible()
  await expect(page.locator('#import-name')).toHaveText('gravador.wav · 1:30')
  await expect(page.locator('#import-origin')).toHaveText('Gravado em · data de modificação do arquivo; confira.')

  await page.locator('#import-date').fill('2026-09-20T08:15')
  await page.locator('#import-confirm').click()
  await expect(page.locator('#import-conversion')).toBeVisible()
  await expect(page.locator('#import-percent')).toHaveText('50%')
  await expect(page.locator('#import-confirm')).toBeDisabled()
  const done = (await request(page)) as { recordedAt: number; recordedAtSource: string }
  expect(done.recordedAtSource).toBe('user')
  expect(done.recordedAt).toBe(new Date(2026, 8, 20, 8, 15).getTime())

  await page.locator('#import-cancel').click()
  await expect(page.locator('[data-view="home"]')).toBeVisible()
  expect((await calls(page)).map((c) => c.command)).toContain('cancel_import')
})

test("a file without audio and a conversion failure appear as errors", async ({ open }) => {
  const page = await open()
  await page.evaluate(() => (window as unknown as { __mock: Mock }).__mock.emit('import-dropped', '/home/ana/tela.mp4'))
  await expect(page.locator('#import-error')).toContainText('tela.mp4 não tem áudio.')
  await expect(page.locator('#import-file')).toBeHidden()

  await adjust(page, { failure: 'disco cheio' })
  await page.locator('#import-choose').click()
  await expect(page.locator('#import-error')).toBeHidden()
  await page.locator('#import-confirm').click()
  await expect(page.locator('#import-error')).toContainText('disco cheio')
  await expect(page.locator('#import-confirm')).toBeEnabled()
  await expect(page.locator('#import-conversion')).toBeHidden()
})

test("cancelling the system picker stays on home", async ({ open }) => {
  const page = await open()
  await adjust(page, { chosen: null })
  await page.locator('#import').click()
  await expect.poll(async () => (await calls(page)).map((c) => c.command)).toContain('pick_import_file')
  await expect(page.locator('[data-view="home"]')).toBeVisible()
  await expect(page.locator('[data-view="import"]')).toBeHidden()
})

test("Ctrl+O opens import and Esc goes back", async ({ open }) => {
  const page = await open()
  await page.keyboard.press('Control+o')
  await expect(page.locator('[data-view="import"]')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-view="home"]')).toBeVisible()
  await page.locator('#import').click()
  await page.locator('#import-close').click()
  await expect(page.locator('[data-view="home"]')).toBeVisible()
})
