import { test, expect, calls } from './fixtures'

test("ongoing voice note: status line, meter, silence and Stop note", async ({ open }) => {
  const page = await open('note')
  await expect(page.locator('#line-status')).toHaveText('Gravando uma nota · para depois de 4 s de silêncio')
  await expect(page.locator('#line-status')).toHaveAttribute('data-status', 'recording')
  await expect(page.locator('#note')).toBeVisible()
  await expect(page.locator('#meter i')).toHaveCount(16)
  await expect(page.locator('#meter i[data-quiet]')).toHaveCount(7)
  const height = await page.locator('#meter i').nth(4).evaluate((i) => i.style.getPropertyValue('--h'))
  expect(height).toBe('90%')
  await expect(page.locator('#note-silence')).toHaveText('Silêncio · para em 3 s')
  await expect(page.locator('#record')).toHaveText('Parar nota · 00:00:42')
  await expect(page.locator('#record')).toHaveAttribute('aria-pressed', 'true')

  await page.locator('#record').click()
  await expect(page.locator('#note')).toBeHidden()
  await expect(page.locator('#record')).toHaveText('Iniciar gravação')
  const made = await calls(page)
  expect(made.map((c) => c.command)).toContain('new_note')
  expect(made.map((c) => c.command)).not.toContain('toggle_recording')
})

test("a voice note set to Never stop does not promise to stop automatically", async ({ open }) => {
  const page = await open('note')
  await page.evaluate(() => {
    const mock = (window as unknown as { __mock: { state: { status: { note_silence_s: number | null } } } }).__mock
    mock.state.status.note_silence_s = null
  })
  await expect(page.locator('#line-status')).toHaveText('Gravando uma nota')
})

test("New note starts a voice note and shows its shortcut", async ({ open }) => {
  const page = await open()
  await expect(page.locator('#shortcut-note')).toHaveText('Ctrl+Alt+N')
  await expect(page.locator('#note')).toBeHidden()
  await page.locator('#new-note').click()
  await expect(page.locator('#note')).toBeVisible()
  await expect(page.locator('#line-status')).toHaveText(/^Gravando uma nota/)
})

test("a marker during recording has a count and note", async ({ open }) => {
  const page = await open('isRecording')
  await expect(page.locator('#markers')).toBeVisible()
  await expect(page.locator('#shortcut-marker')).toHaveText('Ctrl+Alt+M')
  await expect(page.locator('#count-markers')).toBeHidden()
  await expect(page.locator('#note-marker')).toBeHidden()

  await page.locator('#marker').click()
  await expect(page.locator('#count-markers')).toHaveText('1 marcador')
  await expect(page.locator('#count-markers')).toHaveClass(/marker-count/)
  await expect(page.locator('#note-marker')).toBeVisible()
  await expect(page.locator('#note-marker-label')).toHaveText('Nota do marcador em 1:00')
  await expect(page.locator('#note-marker-text')).toBeFocused()
  await page.locator('#note-marker-text').fill('ação para a Ana')
  await page.locator('#note-marker-text').press('Enter')
  await expect
    .poll(async () => (await calls(page)).filter((c) => c.command === 'set_marker_note'))
    .toEqual([{ command: 'set_marker_note', args: { clientId: 'm1', note: 'ação para a Ana' } }])

  await page.locator('#marker').click()
  await expect(page.locator('#count-markers')).toHaveText('2 marcadores')
  await expect(page.locator('#note-marker-text')).toHaveValue('')
})

test("the last marker loads its existing note", async ({ open }) => {
  const page = await open('markers')
  await expect(page.locator('#count-markers')).toHaveText('1 marcador')
  await expect(page.locator('#note-marker-label')).toHaveText('Nota do marcador em 2:05')
  await expect(page.locator('#note-marker-text')).toHaveValue('decisão do orçamento')
  await expect(page.locator('#policy')).toBeHidden()
})

test("there are no markers outside a recording", async ({ open }) => {
  const page = await open()
  await expect(page.locator('#markers')).toBeHidden()
  await expect(page.locator('#policy')).toBeHidden()
})

test("automatic recording shows the app policy and allows changing it", async ({ open }) => {
  const page = await open('isRecording')
  await expect(page.locator('#recording-automatic')).toBeVisible()
  await expect(page.locator('#policy')).toBeVisible()
  await expect(page.locator('#policy-title')).toHaveText('Reuniões no Teams')
  await expect(page.locator('#policy .seg-opt')).toHaveText(['Gravar', 'Confirmar', 'Ignorar'])
  await expect(page.locator('#policy input[value="ask"]')).toBeChecked()

  await page.locator('#policy .seg-opt', { hasText: 'Gravar' }).click()
  await expect(page.locator('#policy input[value="auto"]')).toBeChecked()
  const saved = (await calls(page)).filter((c) => c.command === 'save_settings')
  expect(saved).toHaveLength(1)
  const input = (saved[0].args as { input: { policies: Record<string, string>; web_url: string } }).input
  expect(input.policies.teams).toBe('auto')
  expect(input.policies.zoom).toBe('ask')
  expect(input.web_url).toBe('https://192.168.15.199:8443')
})
