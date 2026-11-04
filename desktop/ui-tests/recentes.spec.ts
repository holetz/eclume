import { test, expect, chamadas as calls } from './fixtures'
import type { Page } from '@playwright/test'

type MockState = {
  clipboard: string | null
  openedRecording: string | null
  summaries: Record<string, string>
  lastInput: Record<string, unknown>
}

async function state(page: Page): Promise<MockState> {
  return page.evaluate(() => (window as unknown as { __mock: { state: MockState } }).__mock.state)
}

const row = (page: Page, key) => page.locator(`#recent-list li[data-key="${key}"]`)

async function setCount(page: Page, value) {
  await page.locator('#open-settings').click()
  await page.locator('#recent-count').selectOption(value)
  await expect.poll(async () => (await state(page)).lastInput?.recent_count).toBe(Number(value))
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-view="home"]')).toBeVisible()
}

test("the Recent panel sits at the top with the last 5 recordings, state, progress and alerts", async ({ abrir: open }) => {
  const page = await open('recent')
  const panel = page.locator('#recent')
  await expect(panel).toBeVisible()
  await expect(panel.locator('.kicker')).toHaveText('Recentes')
  // At the top: before the status line and Record.
  const before = await page.evaluate(() => {
    const recent = document.querySelector('#recent')!
    const status = document.querySelector('#line-status')!
    return Boolean(recent.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING)
  })
  expect(before).toBe(true)

  await expect(page.locator('#recent-list li')).toHaveCount(5)
  await expect(page.locator('#recent-alert')).toHaveText('2 precisam de você')

  // No title: show the short date.
  await expect(row(page, 'local:g1').locator('.recent-title')).toHaveText(/^\d{2}\/\d{2} 10:05$/)
  await expect(row(page, 'local:g1').locator('.badge')).toHaveText('Gravando')

  const failed = row(page, 'local:f1')
  await expect(failed.locator('.badge')).toHaveText('Falhou o envio')
  await expect(failed.locator('.recent-detail')).toHaveText('HTTP 413: arquivo grande demais')
  await expect(failed.getByRole('button', { name: 'Tentar agora' })).toBeVisible()

  const transcribing = row(page, 'srv-t')
  await expect(transcribing.locator('.badge')).toHaveText('Transcrevendo')
  await expect(transcribing.locator('progress')).toHaveJSProperty('value', 42)
  await expect(transcribing.locator('.recent-progress')).toContainText('42%')

  await expect(row(page, 'srv-r').locator('.badge')).toHaveText('Resumo pronto')
  await expect(row(page, 'srv-r').getByRole('button', { name: 'Copiar resumo' })).toBeVisible()
  await expect(row(page, 'srv-r').locator('svg')).toHaveCount(1)
})

test("awaiting speakers (speakers stage in waiting) is an alert linking to the web", async ({ abrir: open }) => {
  const page = await open('recent')
  const unknown = row(page, 'srv-l')
  await expect(unknown).toHaveClass(/recent-alert/)
  await expect(unknown.locator('.badge')).toHaveText('Aguardando locutores')
  await expect(unknown.locator('.badge')).toHaveClass(/badge-warning/)
  await expect(unknown.locator('.recent-detail')).toContainText('Locutores: aguardando você')
  await expect(unknown.locator('.recent-detail')).toContainText('resolva no web')
  await unknown.getByRole('button', { name: 'Abrir no web' }).click()
  await expect.poll(async () => (await state(page)).openedRecording).toBe('srv-l')
  expect(await calls(page)).toContainEqual({ comando: 'open_recording', args: { recordingId: 'srv-l' } })
})

test("Copy summary puts Markdown on the clipboard via Tauri and confirms in the row", async ({ abrir: open }) => {
  const page = await open('recent')
  const ready = row(page, 'srv-r')
  await ready.getByRole('button', { name: 'Copiar resumo' }).click()
  await expect(ready.getByRole('button', { name: 'Copiado' })).toBeVisible()
  await expect(ready.getByRole('status')).toHaveText('Resumo copiado em Markdown.')
  expect(await calls(page)).toContainEqual({ comando: 'copy_summary', args: { recordingId: 'srv-r' } })
  expect((await state(page)).clipboard).toBe('# Comitê de crédito\n\n- Aprovado o limite da cooperativa')
  // Feedback disappears after a few seconds.
  await expect(ready.getByRole('button', { name: 'Copiar resumo' })).toBeVisible({ timeout: 5_000 })
})

test("a failed Copy summary shows the error in the row and copies nothing", async ({ abrir: open }) => {
  const page = await open('recent')
  await page.evaluate(() => {
    ;(window as unknown as { __mock: { state: MockState } }).__mock.state.summaries = {}
  })
  const ready = row(page, 'srv-r')
  await ready.getByRole('button', { name: 'Copiar resumo' }).click()
  await expect(ready.locator('.recent-detail')).toHaveText('O resumo ainda não está pronto')
  await expect(ready.getByRole('button', { name: 'Copiar resumo' })).toBeVisible()
  expect((await state(page)).clipboard).toBeNull()
})

test("Try now requests another upload", async ({ abrir: open }) => {
  const page = await open('recent')
  await row(page, 'local:f1').getByRole('button', { name: 'Tentar agora' }).click()
  await expect.poll(async () => (await calls(page)).some((c) => c.comando === 'sync_now')).toBe(true)
})

test("the count comes from settings and Hide hides the panel", async ({ abrir: open }) => {
  const page = await open('recent')
  await setCount(page, '10')
  await expect(page.locator('#recent-list li')).toHaveCount(7)
  await expect(page.locator('#recent-alert')).toHaveText('3 precisam de você')
  await expect(row(page, 'srv-s').locator('.badge')).toHaveText('O resumo falhou')
  await expect(row(page, 'srv-q').locator('.badge')).toHaveText('Na fila')
  await expect(row(page, 'srv-q').locator('.recent-detail')).toHaveText('2ª na fila')

  await setCount(page, '3')
  await expect(page.locator('#recent-list li')).toHaveCount(3)
  await expect(page.locator('#recent-alert')).toHaveText('1 precisa de você')

  await setCount(page, '0')
  await expect(page.locator('#recent')).toBeHidden()
})

test("with no recordings, the panel says so and shows no alert", async ({ abrir: open }) => {
  const page = await open()
  await expect(page.locator('#recent')).toBeVisible()
  await expect(page.locator('#recent-list li')).toHaveCount(0)
  await expect(page.locator('#recent-empty')).toHaveText('Nenhuma gravação ainda.')
  await expect(page.locator('#recent-alert')).toBeHidden()
})

test("home requests a recent refresh when opened", async ({ abrir: open }) => {
  const page = await open('recent')
  await expect.poll(async () => (await calls(page)).some((c) => c.comando === 'recent_refresh')).toBe(true)
})

for (const [width, height] of [
  [520, 600],
  [380, 420],
]) {
  test(`o painel cabe em ${width} × ${height} sem rolagem horizontal`, async ({ abrir: open }) => {
    const page = await open('recent')
    await page.setViewportSize({ width: width, height: height })
    await expect(page.locator('#recent-list li')).toHaveCount(5)
    const transborda = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)
    expect(transborda).toBe(false)
    const title = row(page, 'srv-l').locator('.recent-title')
    await expect(title).toHaveCSS('text-overflow', 'ellipsis')
  })
}
