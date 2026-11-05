import { test, expect, calls } from './fixtures'

test("home loads with app fonts and no external requests", async ({ open, externalRequests }) => {
  const page = await open()
  await expect(page.locator('[data-view="home"]')).toBeVisible()
  await expect(page.locator('[data-view="home"] .brand')).toHaveText('eclume')
  await expect(page.locator('#open-settings svg')).toBeVisible()
  await expect(page.locator('#line-status')).not.toHaveText('Carregando…')

  const families = await page.evaluate(async () => {
    await document.fonts.ready
    return [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replaceAll('"', ''))
  })
  expect(families).toContain('Archivo')
  expect(externalRequests).toEqual([])
})

test("the theme follows the system", async ({ open }) => {
  const page = await open()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  const fundo = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  expect(fundo).toBe('rgb(30, 28, 25)')
})

test("idle: status, record, queue and account", async ({ open }) => {
  const page = await open()
  await expect(page.locator('#line-status')).toHaveText('Ocioso, atento a reuniões')
  await expect(page.locator('#record')).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('#record')).toHaveText('Iniciar gravação')
  await expect(page.locator('#prompt')).toBeHidden()
  await expect(page.locator('#queue li')).toHaveCount(3)
  await expect(page.locator('#queue li').first()).toContainText('Hoje, 09:00 · 54 min')
  await expect(page.locator('#queue li').first().locator('.badge')).toHaveText('Enviada')
  await expect(page.locator('#queue-summary')).toHaveText('3 de 3 enviadas')
  await expect(page.locator('#account-name')).toHaveText('ana@exemplo.com.br')
  await expect(page.locator('#account-server')).toHaveText('eclume em 192.0.2.10')
  await expect(page.locator('#account-version')).toHaveText('v0.2.0')
  await expect(page.locator('#account-action')).toHaveText('Sair')
})

test("recording toggles the button and status line", async ({ open }) => {
  const page = await open()
  await page.locator('#record').click()
  await expect(page.locator('#record')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('#record')).toHaveText('Parar gravação')
  await expect(page.locator('#line-status')).toHaveAttribute('data-status', 'recording')
  await expect(page.locator('#line-status')).toHaveText(/^Gravando · 0:0\d$/)
})

test("automatic recording shows the app and elapsed time", async ({ open }) => {
  const page = await open('isRecording')
  await expect(page.locator('#line-status')).toHaveText(/^Gravando Microsoft Teams · 12:0\d$/)
  await expect(page.locator('#queue li').first().locator('.badge')).toHaveText('Gravando')
})

test("meeting prompt offers Record and Not now", async ({ open }) => {
  const page = await open('prompt')
  await expect(page.locator('#prompt')).toBeVisible()
  await expect(page.locator('#prompt .alert-warning')).toContainText('Zoom está usando o microfone. Gravar?')
  await page.locator('#prompt-now-no').click()
  await expect(page.locator('#prompt')).toBeHidden()
  const made = await calls(page)
  expect(made).toContainEqual({ command: 'answer_meeting', args: { record: false } })
})

test("the queue shows vocabulary badges, voice note, import and visible error", async ({ open }) => {
  const page = await open('queue')
  const rows = page.locator('#queue li')
  await expect(rows.locator('.badge')).toHaveText(['Enviando', 'Enviada', 'Falhou o envio', 'Aguardando envio'])
  await expect(rows.nth(1)).toContainText('Hoje, 08:18 · Nota · 1 min')
  await expect(rows.nth(2).locator('.badge')).toHaveClass(/badge-danger/)
  await expect(rows.nth(2).locator('.queue-error')).toBeVisible()
  await expect(rows.nth(2).locator('.queue-error')).toHaveText('HTTP 413: arquivo grande demais')
  await expect(rows.nth(3)).toContainText('kickoff-guion · 47 min')
  await expect(page.locator('#queue-summary')).toHaveText('1 de 4 enviadas')
})

test("the queue shows the title given on stopping, otherwise the server title", async ({ open }) => {
  const page = await open('titles')
  const rows = page.locator('#queue li')
  await expect(rows.nth(0)).toContainText('Alinhamento semanal · 54 min')
  await expect(rows.nth(1)).toContainText('Ideia do orçamento · 1 min')
  await expect(rows.nth(2)).toContainText('· 22 min')
})

test("an uploaded recording with queued server transcription explains its wait", async ({ open }) => {
  const page = await open('wait')
  const rows = page.locator('#queue li')
  await expect(rows.nth(0).locator('.queue-wait')).toHaveText('Atrás de 2 gravações suas que chegaram antes.')
  await expect(rows.nth(1).locator('.queue-wait')).toHaveText(
    'O processador está fora do ar; sua gravação está guardada e entra quando ele voltar.',
  )
  await expect(rows.nth(2).locator('.queue-wait')).toHaveCount(0)
})

test("empty queue with the upload notice", async ({ open }) => {
  const page = await open('empty')
  await expect(page.locator('#line-status')).toHaveText('Tudo enviado')
  await expect(page.locator('#queue-empty')).toBeVisible()
  await expect(page.locator('#notice')).toContainText('o servidor respondeu 503')
})

test("account sign-out clears the credential and returns to first run", async ({ open }) => {
  const page = await open()
  await page.locator('#account-action').click()
  await expect(page.locator('[data-view="first-run"]')).toBeVisible()
  expect((await calls(page)).map((c) => c.command)).toContain('sign_out')
})

test("a command error appears and clears on the next successful command", async ({ open }) => {
  const page = await open('isRecording')
  await page.locator('#new-note').click()
  await expect(page.locator('#notice.alert-error')).toContainText('Já há uma gravação em andamento')
  await page.locator('#record').click()
  await expect(page.locator('#notice')).toBeHidden()
})

test("after an update: Updated to X with notes until dismissed", async ({ open }) => {
  const page = await open('updated')
  const notice = page.locator('#updated')
  await expect(notice).toBeVisible()
  await expect(notice).toHaveClass(/alert-success/)
  await expect(page.locator('#updated-title')).toHaveText('Atualizado para 0.2.0')
  await expect(page.locator('#updated-notes')).toHaveText('Nova nota, Importar arquivo e entrar com e-mail e senha')
  await page.locator('#updated-close').click()
  await expect(notice).toBeHidden()
  expect((await calls(page)).map((c) => c.command)).toContain('dismiss_update_notice')
})

test("no update means no notice", async ({ open }) => {
  const page = await open()
  await expect(page.locator('#line-status')).not.toHaveText('Carregando…')
  await expect(page.locator('#updated')).toBeHidden()
})
