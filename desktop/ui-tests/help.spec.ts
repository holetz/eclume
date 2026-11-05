import { test, expect, calls } from './fixtures'

test("the help icon opens the DS menu with the version", async ({ open }) => {
  const page = await open()
  await expect(page.locator('#menu-help')).toBeHidden()
  await page.locator('#open-help').click()
  await expect(page.locator('#menu-help')).toBeVisible()
  await expect(page.locator('#open-help')).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator('#menu-help [role=menuitem]')).toHaveText([
    'Primeiros passos',
    'Permissões de microfone',
    'Pasta sincronizada',
    /Atalhos de teclado\s*Ctrl\+\//,
    /Abrir a central de ajuda\s*↗/,
    /Relatar um problema…\s*Anexe o eclume\.log/,
  ])
  await expect(page.locator('#help-version')).toHaveText('eclume 0.2.0 · atualizado')
  await expect(page.locator('#help-version')).toHaveAttribute('aria-disabled', 'true')

  await page.keyboard.press('Escape')
  await expect(page.locator('#menu-help')).toBeHidden()
  await page.locator('#open-help').click()
  await page.locator('[data-view="home"] .brand').click()
  await expect(page.locator('#menu-help')).toBeHidden()
})

test("menu items open server help and the log folder", async ({ open }) => {
  const page = await open()
  for (const id of ['#help-first-steps', '#help-permissions', '#help-folder', '#help-center', '#help-problem']) {
    await page.locator('#open-help').click()
    await page.locator(id).click()
    await expect(page.locator('#menu-help')).toBeHidden()
  }
  const made = (await calls(page)).filter((c) => c.command === 'open_help' || c.command === 'open_log_dir')
  expect(made).toEqual([
    { command: 'open_help', args: { article: 'first-recording' } },
    { command: 'open_help', args: { article: 'microphone-permissions' } },
    { command: 'open_help', args: { article: 'synced-folder' } },
    { command: 'open_help', args: { article: null } },
    { command: 'open_log_dir', args: null },
  ])
})

test("Keyboard shortcuts via menu and Ctrl+/: global settings and window shortcuts", async ({ open }) => {
  const page = await open()
  await page.locator('#open-help').click()
  await page.locator('#help-shortcuts').click()
  const sheet = page.locator('[data-view="shortcuts"]')
  await expect(sheet).toBeVisible()
  await expect(sheet.locator('#shortcuts-global dt')).toHaveText(['Iniciar ou parar a gravação', 'Nova nota', 'Adicionar marcador'])
  await expect(sheet.locator('#shortcuts-global > div').nth(1).locator('.kbd')).toHaveText(['Ctrl', 'Alt', 'N'])
  await expect(sheet.locator('#shortcuts-window dt')).toHaveText(['Importar arquivo', 'Configurações', 'Atalhos de teclado'])
  await expect(sheet.locator('#shortcuts-window > div').nth(1).locator('.kbd')).toHaveText(['Ctrl', ','])

  await page.locator('#shortcuts-close').click()
  await expect(page.locator('[data-view="home"]')).toBeVisible()
  await page.keyboard.press('Control+/')
  await expect(sheet).toBeVisible()
  await page.locator('#shortcuts-change').click()
  await expect(page.locator('[data-panel="audio"]')).toBeVisible()
})

test("Ctrl+, opens settings and Ctrl+O opens import from any view", async ({ open }) => {
  const page = await open()
  await page.keyboard.press('Control+/')
  await page.keyboard.press('Control+,')
  await expect(page.locator('[data-view="settings"]')).toBeVisible()
  await page.keyboard.press('Control+o')
  await expect(page.locator('[data-view="import"]')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-view="home"]')).toBeVisible()
})
