import { test, expect, chamadas as calls } from './fixtures'
import type { Page } from '@playwright/test'

type Input = Record<string, unknown> & { policies: Record<string, string> }

async function lastInput(page: Page): Promise<Input> {
  return page.evaluate(() => (window as unknown as { __mock: { state: { lastInput: Input } } }).__mock.state.lastInput)
}

test("Ctrl+, opens General with Appearance, Startup and Notifications; Meetings only has detection", async ({ abrir: open }) => {
  const page = await open()
  await page.keyboard.press('Control+,')
  await expect(page.locator('[data-view="settings"]')).toBeVisible()
  await expect(page.locator('[role="tab"]')).toHaveText(['Geral', 'Reuniões', 'Áudio', 'Armazenamento', 'Pasta', 'Servidor'])
  await expect(page.locator('[data-tab="general"]')).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('[data-panel="general"] .kicker')).toHaveText(['Aparência', 'Início', 'Avisos'])
  await expect(page.locator('[data-panel="meetings"]')).toBeHidden()
  await page.locator('[data-tab="meetings"]').click()
  await expect(page.locator('[data-panel="general"]')).toBeHidden()
  await expect(page.locator('[data-panel="meetings"] #theme, [data-panel="meetings"] #notify-summary')).toHaveCount(0)
})

test("Meetings has all 8 apps, DS subtitles and each app’s policy", async ({ abrir: open }) => {
  const page = await open()
  await page.keyboard.press('Control+,')
  await page.locator('[data-tab="meetings"]').click()
  await expect(page.locator('[data-tab="meetings"]')).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('#detect')).toBeChecked()
  const rows = page.locator('#apps .list-row')
  await expect(rows).toHaveCount(8)
  await expect(rows.locator('.list-row-title')).toHaveText([
    'Microsoft Teams',
    'Zoom',
    'Google Meet',
    'Webex',
    'Slack',
    'WhatsApp',
    'Navegador',
    'Outro app',
  ])
  await expect(rows.nth(4).locator('.list-row-sub')).toHaveText('Chamadas')
  await expect(rows.nth(5).locator('.list-row-sub')).toHaveText('App ou aba do WhatsApp Web')
  await expect(rows.nth(6).locator('.list-row-sub')).toHaveText('Microfone em uso, reunião não reconhecida')
  await expect(rows.nth(7).locator('input[value="ignore"]')).toBeChecked()
  await expect(rows.first().locator('.seg-opt')).toHaveText(['Gravar', 'Confirmar', 'Ignorar'])
})

test("General: processing completion notifications start enabled and save immediately", async ({ abrir: open }) => {
  const page = await open()
  await page.locator('#open-settings').click()
  await expect(page.locator('#notify-summary')).toBeChecked()
  await page.locator('label.switch', { hasText: 'Avisar quando uma gravação terminar de processar' }).click()
  await expect(page.locator('#notify-summary')).not.toBeChecked()
  expect((await lastInput(page)).notify_summary).toBe(false)
})

test("General: recent recordings in the window default to 5 and save immediately", async ({ abrir: open }) => {
  const page = await open()
  await page.locator('#open-settings').click()
  await expect(page.locator('label[for="recent-count"]')).toHaveText('Gravações recentes na janela')
  await expect(page.locator('#recent-count')).toHaveValue('5')
  await expect(page.locator('#recent-count option')).toHaveText(['Ocultar', '3', '5', '10'])
  await page.locator('#recent-count').selectOption('10')
  await expect.poll(async () => (await lastInput(page)).recent_count).toBe(10)
})

test("General: tray recent recordings default to 1, separate from the window, and save immediately", async ({
  abrir: open,
}) => {
  const page = await open()
  await page.locator('#open-settings').click()
  await expect(page.locator('label[for="recent-tray-count"]')).toHaveText(
    'Gravações recentes no menu da bandeja',
  )
  await expect(page.locator('#recent-tray-count')).toHaveValue('1')
  await expect(page.locator('#recent-tray-count option')).toHaveText(['Ocultar', '1', '3', '5'])
  await page.locator('#recent-tray-count').selectOption('3')
  await expect.poll(async () => (await lastInput(page)).tray_recent_count).toBe(3)
  // The window count stays as it was: omitted from the input, it keeps the current value.
  expect((await lastInput(page)).recent_count).toBeUndefined()
  await expect(page.locator('#recent-count')).toHaveValue('5')
  await page.locator('#recent-tray-count').selectOption('0')
  await expect.poll(async () => (await lastInput(page)).tray_recent_count).toBe(0)
})

test("General: autostart starts enabled and saves immediately", async ({ abrir: open }) => {
  const page = await open()
  await page.locator('#open-settings').click()
  await expect(page.locator('#start-with-the-system')).toBeChecked()
  await page.locator('label.switch', { hasText: 'Iniciar com o computador' }).click()
  await expect(page.locator('#start-with-the-system')).not.toBeChecked()
  expect((await lastInput(page)).autostart).toBe(false)
})

test("policy changes, disabling detection and restoring defaults save immediately", async ({ abrir: open }) => {
  const page = await open()
  await page.locator('#open-settings').click()
  await page.locator('[data-tab="meetings"]').click()
  const zoom = page.locator('#apps .list-row[data-app="zoom"]')
  await zoom.locator('.seg-opt', { hasText: 'Gravar' }).click()
  await expect(zoom.locator('input[value="auto"]')).toBeChecked()
  expect((await lastInput(page)).policies.zoom).toBe('auto')

  await page.locator('.switch', { hasText: 'Detectar reuniões' }).click()
  await expect(page.locator('#detect')).not.toBeChecked()
  expect((await lastInput(page)).detection_enabled).toBe(false)

  await page.locator('#restore-defaults').click()
  await expect(zoom.locator('input[value="ask"]')).toBeChecked()
  const input = await lastInput(page)
  expect(input.policies).toEqual({
    teams: 'ask',
    zoom: 'ask',
    meet: 'ask',
    webex: 'ask',
    slack: 'ask',
    whatsapp: 'ask',
    navegador: 'ask',
    outro: 'ignore',
  })
})

test("Storage: three retention choices, local folder, space and retry", async ({ abrir: open }) => {
  const page = await open()
  await page.locator('#open-settings').click()
  await page.locator('[data-tab="storage"]').click()
  await expect(page.locator('[data-panel="storage"]')).toBeVisible()
  await expect(page.locator('[data-panel="general"]')).toBeHidden()
  await expect(page.locator('input[name="retention"][value="days"]')).toBeChecked()
  await expect(page.locator('#retention-days')).toHaveValue('7')
  await expect(page.locator('#folder-local')).toHaveText('/home/ana/.local/share/eclume/gravacoes')
  await expect(page.locator('#space-used')).toHaveText('3 gravações · 41 MB neste computador')

  await page.locator('.choice', { hasText: 'Manter para sempre' }).click()
  await expect(page.locator('#retention-days')).toBeDisabled()
  expect((await lastInput(page)).retention_days).toBeNull()

  await page.locator('.choice', { hasText: 'Apagar a cópia local' }).click()
  expect((await lastInput(page)).retention_days).toBe(0)

  await page.locator('.choice', { hasText: 'Manter por alguns dias' }).click()
  await page.locator('#retention-days').fill('30')
  await page.locator('#retention-days').press('Enter')
  await expect.poll(async () => (await lastInput(page)).retention_days).toBe(30)

  await page.locator('#retention-days').fill('4000')
  await page.locator('#retention-days').press('Enter')
  await expect(page.locator('#config-notice')).toContainText('Use de 1 a 3650 dias.')

  await page.locator('#show-folder').click()
  await page.locator('#retry').click()
  await expect(page.locator('#config-notice')).toContainText('As falhas vão ser enviadas de novo.')
  const commands = (await calls(page)).map((c) => c.comando)
  expect(commands).toContain('open_data_dir')
  expect(commands).toContain('sync_now')
})

test("Server: account sign-out, address, extra CA dialog and connection test", async ({ abrir: open }) => {
  const page = await open()
  await page.locator('#open-settings').click()
  await page.locator('[data-tab="server"]').click()
  await expect(page.locator('#server-account')).toHaveText('ana@exemplo.com.br')
  await expect(page.locator('#server-account-sub')).toHaveText('Conectado ao eclume em 192.168.15.199')
  await expect(page.locator('#server-sign-in')).toBeHidden()
  await expect(page.locator('#server-address')).toHaveValue('https://192.168.15.199:8443')
  // The PAT paste field was removed from the screen.
  await expect(page.locator('#server-token')).toHaveCount(0)

  await page.locator('#server-test').click()
  await expect(page.locator('#server-connection')).toHaveText('Conectado · último envio 10:38')
  await expect(page.locator('#server-connection')).toHaveAttribute('data-status', 'synced')

  await page.locator('#server-address').fill('sem-esquema')
  await page.locator('#server-save').click()
  await expect(page.locator('#config-notice.alert-error')).toContainText('endereço inválido')

  await page.locator('[data-panel="server"] .disclosure summary').click()
  await expect(page.locator('#server-ca')).toHaveText('Nenhuma')
  await page.locator('#server-ca-choose').click()
  await expect(page.locator('#server-ca')).toHaveText('/home/ana/caddy-root.pem')
  await page.locator('#server-address').fill('https://eclume.local:8443')
  await page.locator('#server-save').click()
  await expect(page.locator('#config-notice.alert-success')).toContainText('Configurações do servidor salvas.')
  const input = await lastInput(page)
  expect(input.web_url).toBe('https://eclume.local:8443')
  expect(input.ca_path).toBe('/home/ana/caddy-root.pem')
  expect(input.api_url).toBeNull()
  expect(input.pat).toBeUndefined()

  await page.locator('#server-sign-out').click()
  await expect(page.locator('[data-view="first-run"]')).toBeVisible()
  expect((await calls(page)).map((c) => c.comando)).toContain('sign_out')
})

test("Server with a legacy PAT: stays connected and offers email and password sign-in", async ({ abrir: open }) => {
  const page = await open('pat')
  await expect(page.locator('#account-name')).toHaveText('Conectado com um token pessoal')
  await page.locator('#account-action').click()
  await expect(page.locator('[data-tab="server"]')).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('#server-account')).toHaveText('Conectado com um token pessoal')
  await expect(page.locator('#server-sign-out')).toBeVisible()
  await page.locator('#server-sign-in').click()
  await expect(page.locator('[data-view="first-run"]')).toBeVisible()
  await expect(page.locator('#first-run-back')).toBeVisible()
  await page.locator('#first-run-back').click()
  await expect(page.locator('[data-view="home"]')).toBeVisible()
})

test("Audio: microphone by name, system output and silence stop save immediately", async ({ abrir: open }) => {
  const page = await open()
  await page.locator('#open-settings').click()
  await page.locator('[data-tab="audio"]').click()
  await expect(page.locator('[data-panel="audio"]')).toBeVisible()
  await expect(page.locator('#microphone option')).toHaveText([
    'Padrão do sistema · Microfone embutido',
    'Microfone embutido',
    'Jabra Evolve2 65',
    'Nenhum',
  ])
  await expect(page.locator('#microphone')).toHaveValue('')
  await expect(page.locator('#audio-system option')).toHaveText([
    'Seguir a saída em uso',
    'Alto-falantes embutidos',
    'Jabra Evolve2 65',
    'Nenhum',
  ])
  await expect(page.locator('#audio-system')).toHaveValue('follow')
  await expect(page.locator('input[name="silence"][value="4"]')).toBeChecked()

  await page.locator('#microphone').selectOption('Jabra Evolve2 65')
  await expect.poll(async () => (await lastInput(page)).mic).toBe('Jabra Evolve2 65')

  await page.locator('#audio-system').selectOption('bluez_output.jabra')
  await expect.poll(async () => (await lastInput(page)).system_source).toBe('bluez_output.jabra')

  await page.locator('#silence .seg-opt', { hasText: 'Nunca' }).click()
  await expect(page.locator('input[name="silence"][value="0"]')).toBeChecked()
  expect((await lastInput(page)).note_silence_s).toBe(0)
  await page.locator('#silence .seg-opt', { hasText: '8 s' }).click()
  await expect.poll(async () => (await lastInput(page)).note_silence_s).toBe(8)

  await expect(page.locator('#language')).toHaveValue('')
  await expect(page.locator('#language option')).toHaveText([
    'Padrão da conta: Português',
    'Detectar automaticamente',
    'Português',
    'Español',
    'English',
  ])
  await page.locator('#language').selectOption('es')
  await expect.poll(async () => (await lastInput(page)).language).toBe('es')
  await expect(page.locator('#language')).toHaveValue('es')
  await page.locator('#language').selectOption('auto')
  await expect.poll(async () => (await lastInput(page)).language).toBe('auto')
  await page.locator('#language').selectOption('')
  await expect.poll(async () => (await lastInput(page)).language).toBe('')
})

test("Audio: None disables each source’s test, and both sources set to None are rejected", async ({ abrir: open }) => {
  const page = await open()
  await page.locator('#open-settings').click()
  await page.locator('[data-tab="audio"]').click()
  await expect(page.locator('#test-mic')).toBeEnabled()
  await expect(page.locator('#test-system')).toBeEnabled()

  await page.locator('#audio-system').selectOption('none')
  await expect.poll(async () => (await lastInput(page)).system_source).toBe('none')
  await expect(page.locator('#test-system')).toBeDisabled()
  await expect(page.locator('#test-mic')).toBeEnabled()

  await page.locator('#microphone').selectOption('none')
  await expect(page.locator('#config-notice')).toContainText('Escolha ao menos uma fonte de áudio')
  await expect(page.locator('#microphone')).toHaveValue('')

  await page.locator('#audio-system').selectOption('follow')
  await expect.poll(async () => (await lastInput(page)).system_source).toBe('follow')
  await page.locator('#microphone').selectOption('none')
  await expect.poll(async () => (await lastInput(page)).mic).toBe('none')
  await expect(page.locator('#test-mic')).toBeDisabled()
  await expect(page.locator('#test-system')).toBeEnabled()
})

test("Audio: microphone test shows the meter, changes to Stop and resets at the end", async ({ abrir: open }) => {
  const page = await open()
  await page.locator('#open-settings').click()
  await page.locator('[data-tab="audio"]').click()
  await expect(page.locator('#meter-test i')).toHaveCount(16)
  await page.locator('#test-mic').click()
  await expect(page.locator('#test-mic')).toHaveText('Parar')
  await expect(page.locator('#test-system')).toHaveText('Toque algo para testar')
  await expect(page.locator('#meter-test i:not([data-quiet])')).toHaveCount(6)
  await expect(page.locator('#test-mic')).toHaveText('Fale para testar')
  await expect(page.locator('#meter-test i[data-quiet]')).toHaveCount(16)
  expect((await calls(page)).filter((c) => c.comando === 'source_test')).toEqual([
    { comando: 'source_test', args: { source: 'mic' } },
  ])
})

test("Audio: Stop ends the system test early", async ({ abrir: open }) => {
  const page = await open()
  await page.locator('#open-settings').click()
  await page.locator('[data-tab="audio"]').click()
  await page.locator('#test-system').click()
  await expect(page.locator('#test-system')).toHaveText('Parar')
  await expect(page.locator('#meter-test i:not([data-quiet])')).toHaveCount(6)
  await page.locator('#test-system').click()
  await expect(page.locator('#test-system')).toHaveText('Toque algo para testar')
  await expect(page.locator('#meter-test i[data-quiet]')).toHaveCount(16)
  const tests = (await calls(page)).filter((c) => ['source_test', 'source_test_stop'].includes(c.comando))
  expect(tests).toEqual([
    { comando: 'source_test', args: { source: 'system' } },
    { comando: 'source_test_stop', args: null },
  ])
})

test("Audio on Wayland without a portal: create and remove GNOME shortcuts", async ({ abrir: open }) => {
  const page = await open('wayland')
  await page.locator('#open-settings').click()
  await page.locator('[data-tab="audio"]').click()
  await expect(page.locator('#shortcuts-mode')).toHaveText(
    'Nesta sessão (Wayland), o eclume não ouve o teclado sozinho: crie os atalhos no GNOME.',
  )
  const rows = page.locator('#shortcuts .list-row')
  await expect(rows.locator('.list-row-sub')).toHaveText(Array(3).fill('Crie o atalho no sistema'))
  await expect(rows.locator('.shortcut-command')).toHaveCount(0)

  await page.locator('#shortcuts-gnome', { hasText: 'Criar atalhos no GNOME' }).click()
  await expect(page.locator('#config-notice')).toContainText('Atalhos criados no GNOME.')
  await expect(rows.locator('.list-row-sub')).toHaveText(Array(3).fill('Funciona com o eclume em segundo plano'))
  await expect(page.locator('#shortcuts-mode')).toHaveText('Nesta sessão (Wayland), os atalhos são do GNOME e chamam o eclume.')
  expect((await calls(page)).filter((c) => c.comando === 'system_shortcuts')).toEqual([
    { comando: 'system_shortcuts', args: { install: true } },
  ])

  await page.locator('#shortcuts-gnome', { hasText: 'Remover atalhos do GNOME' }).click()
  await expect(page.locator('#config-notice')).toContainText('Atalhos removidos do GNOME.')
  await expect(page.locator('#shortcuts-gnome')).toHaveText('Criar atalhos no GNOME')
})

test("Audio: shortcut registration status and replacement with the next combination", async ({ abrir: open }) => {
  const page = await open('shortcutInUse')
  await page.locator('#open-settings').click()
  await page.locator('[data-tab="audio"]').click()
  await expect(page.locator('#microphone')).toHaveValue('Headset antigo')
  await expect(page.locator('#microphone option:checked')).toHaveText('Headset antigo (desconectado)')

  await expect(page.locator('#shortcuts-mode')).toBeHidden()
  await expect(page.locator('#shortcuts-gnome')).toBeHidden()
  const rows = page.locator('#shortcuts .list-row')
  await expect(rows.locator('.list-row-title')).toHaveText(['Iniciar ou parar a gravação', 'Nova nota', 'Adicionar marcador'])
  await expect(rows.locator('kbd')).toHaveText(['Ctrl+Alt+R', 'Ctrl+Alt+N', 'Ctrl+Alt+M'])
  await expect(rows.nth(1).locator('.list-row-sub')).toHaveText('Em uso por outro app')
  await expect(rows.nth(1).locator('.list-row-sub')).toHaveAttribute('data-problem', '')

  const marker = page.locator('#shortcuts [data-shortcut="marker"]')
  await marker.getByRole('button', { name: 'Alterar' }).click()
  await expect(marker.locator('kbd')).toHaveText('Pressione a combinação…')
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-view="settings"]')).toBeVisible()
  await expect(marker.locator('kbd')).toHaveText('Ctrl+Alt+M')

  await marker.getByRole('button', { name: 'Alterar' }).click()
  await page.keyboard.press('j')
  await expect(page.locator('#config-notice')).toContainText('Use Ctrl, Alt, Shift ou ⌘')
  await page.keyboard.press('Control+Alt+KeyJ')
  await expect(marker.locator('kbd')).toHaveText('Ctrl+Alt+J')
  const input = await lastInput(page)
  expect(input.shortcuts).toEqual({ record: 'Ctrl+Alt+R', note: 'Ctrl+Alt+N', marker: 'Ctrl+Alt+J' })
})

test("Sync: starts disabled, chooses a folder, enables and explains collections, Obsidian and agents", async ({ abrir: open }) => {
  const page = await open()
  await page.locator('#open-settings').click()
  await page.locator('[data-tab="folder"]').click()
  await expect(page.locator('[data-panel="folder"]')).toBeVisible()
  await expect(page.locator('#folder-enable')).not.toBeChecked()
  await expect(page.locator('#folder-transcripts')).toBeChecked()
  await expect(page.locator('#folder-path')).toHaveText('Nenhuma')
  await expect(page.locator('#folder-estado')).toHaveText('Desligada')
  await expect(page.locator('#folder-now')).toBeDisabled()

  // The text explains what goes into the folder and how Obsidian and agents can use it.
  const como = page.locator('#folder-layout')
  await expect(como).toContainText('Coleções viram subpastas, e cada uma se divide por mês')
  await expect(como).toContainText('2026-09-18_1100_01928f3a.md')
  await expect(como).toContainText('O título fica dentro do arquivo')
  await expect(como).toContainText('sem-colecao')
  await expect(como).toContainText('Vault do Obsidian')
  await expect(como).toContainText('AGENTS.md')
  await expect(como).toContainText('É um espelho')

  // Enabling without a folder is rejected and the switch resets.
  await page.locator('label.switch', { hasText: 'Sincronizar resumos numa pasta' }).click()
  await expect(page.locator('#config-notice.alert-error')).toContainText('Escolha a pasta dos resumos')
  await expect(page.locator('#folder-enable')).not.toBeChecked()

  await page.locator('#folder-choose').click()
  await expect(page.locator('#folder-path')).toHaveText('/home/ana/Obsidian/eclume')
  expect((await lastInput(page)).mirror_dir).toBe('/home/ana/Obsidian/eclume')
  await expect(page.locator('#folder-estado')).toHaveText('Desligada')

  await page.locator('label.switch', { hasText: 'Sincronizar resumos numa pasta' }).click()
  await expect(page.locator('#folder-enable')).toBeChecked()
  expect((await lastInput(page)).mirror_enabled).toBe(true)
  await expect(page.locator('#folder-estado')).toHaveText('Aguardando o primeiro ciclo')
  await expect(page.locator('#folder-now')).toBeEnabled()

  await page.locator('label.switch', { hasText: 'Incluir as transcrições' }).click()
  await expect(page.locator('#folder-transcripts')).not.toBeChecked()
  expect((await lastInput(page)).mirror_transcripts).toBe(false)
})

test("Sync: Sync now requests a cycle and displays its result; help opens the article", async ({ abrir: open }) => {
  const page = await open()
  await page.locator('#open-settings').click()
  await page.locator('[data-tab="folder"]').click()
  await page.locator('#folder-choose').click()
  await page.locator('label.switch', { hasText: 'Sincronizar resumos numa pasta' }).click()
  await page.locator('#folder-now').click()
  await expect(page.locator('#folder-estado')).toContainText('12 gravações lidas no último ciclo')
  await expect(page.locator('#folder-estado')).toHaveAttribute('data-status', 'synced')
  await page.locator('#folder-help').click()
  const made = (await calls(page)).filter((c) => c.comando === 'mirror_sync_now' || c.comando === 'open_help')
  expect(made).toEqual([
    { comando: 'mirror_sync_now', args: null },
    { comando: 'open_help', args: { article: 'pasta-sincronizada' } },
  ])
})
