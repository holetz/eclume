import { test, expect, chamadas } from './fixtures'

test('nota em curso: linha de status, medidor, silêncio e Parar nota', async ({ abrir }) => {
  const page = await abrir('nota')
  await expect(page.locator('#linha-status')).toHaveText('Gravando uma nota · para depois de 4 s de silêncio')
  await expect(page.locator('#linha-status')).toHaveAttribute('data-status', 'recording')
  await expect(page.locator('#nota')).toBeVisible()
  await expect(page.locator('#medidor i')).toHaveCount(16)
  await expect(page.locator('#medidor i[data-quiet]')).toHaveCount(7)
  const altura = await page.locator('#medidor i').nth(4).evaluate((i) => i.style.getPropertyValue('--h'))
  expect(altura).toBe('90%')
  await expect(page.locator('#nota-silencio')).toHaveText('Silêncio · para em 3 s')
  await expect(page.locator('#gravar')).toHaveText('Parar nota · 00:00:42')
  await expect(page.locator('#gravar')).toHaveAttribute('aria-pressed', 'true')

  await page.locator('#gravar').click()
  await expect(page.locator('#nota')).toBeHidden()
  await expect(page.locator('#gravar')).toHaveText('Iniciar gravação')
  const feitas = await chamadas(page)
  expect(feitas.map((c) => c.comando)).toContain('new_note')
  expect(feitas.map((c) => c.comando)).not.toContain('toggle_recording')
})

test('nota com parada "Nunca" não promete parar sozinha', async ({ abrir }) => {
  const page = await abrir('nota')
  await page.evaluate(() => {
    const mock = (window as unknown as { __mock: { estado: { status: { note_silence_s: number | null } } } }).__mock
    mock.estado.status.note_silence_s = null
  })
  await expect(page.locator('#linha-status')).toHaveText('Gravando uma nota')
})

test('Nova nota começa a nota e mostra o atalho', async ({ abrir }) => {
  const page = await abrir()
  await expect(page.locator('#atalho-nota')).toHaveText('Ctrl+Alt+N')
  await expect(page.locator('#nota')).toBeHidden()
  await page.locator('#nova-nota').click()
  await expect(page.locator('#nota')).toBeVisible()
  await expect(page.locator('#linha-status')).toHaveText(/^Gravando uma nota/)
})

test('marcador durante a gravação, com contagem e nota', async ({ abrir }) => {
  const page = await abrir('gravando')
  await expect(page.locator('#marcadores')).toBeVisible()
  await expect(page.locator('#atalho-marcador')).toHaveText('Ctrl+Alt+M')
  await expect(page.locator('#contagem-marcadores')).toBeHidden()
  await expect(page.locator('#nota-marcador')).toBeHidden()

  await page.locator('#marcador').click()
  await expect(page.locator('#contagem-marcadores')).toHaveText('1 marcador')
  await expect(page.locator('#contagem-marcadores')).toHaveClass(/marker-count/)
  await expect(page.locator('#nota-marcador')).toBeVisible()
  await expect(page.locator('#nota-marcador-rotulo')).toHaveText('Nota do marcador em 1:00')
  await expect(page.locator('#nota-marcador-texto')).toBeFocused()
  await page.locator('#nota-marcador-texto').fill('ação para a Ana')
  await page.locator('#nota-marcador-texto').press('Enter')
  await expect
    .poll(async () => (await chamadas(page)).filter((c) => c.comando === 'set_marker_note'))
    .toEqual([{ comando: 'set_marker_note', args: { clientId: 'm1', note: 'ação para a Ana' } }])

  await page.locator('#marcador').click()
  await expect(page.locator('#contagem-marcadores')).toHaveText('2 marcadores')
  await expect(page.locator('#nota-marcador-texto')).toHaveValue('')
})

test('o último marcador traz a nota que já tem', async ({ abrir }) => {
  const page = await abrir('marcadores')
  await expect(page.locator('#contagem-marcadores')).toHaveText('1 marcador')
  await expect(page.locator('#nota-marcador-rotulo')).toHaveText('Nota do marcador em 2:05')
  await expect(page.locator('#nota-marcador-texto')).toHaveValue('decisão do orçamento')
  await expect(page.locator('#politica')).toBeHidden()
})

test('fora de gravação não há marcador', async ({ abrir }) => {
  const page = await abrir()
  await expect(page.locator('#marcadores')).toBeHidden()
  await expect(page.locator('#politica')).toBeHidden()
})

test('gravação automática mostra a política do app e deixa mudá-la', async ({ abrir }) => {
  const page = await abrir('gravando')
  await expect(page.locator('#gravacao-automatica')).toBeVisible()
  await expect(page.locator('#politica')).toBeVisible()
  await expect(page.locator('#politica-titulo')).toHaveText('Reuniões no Teams')
  await expect(page.locator('#politica .seg-opt')).toHaveText(['Gravar', 'Perguntar', 'Ignorar'])
  await expect(page.locator('#politica input[value="ask"]')).toBeChecked()

  await page.locator('#politica .seg-opt', { hasText: 'Gravar' }).click()
  await expect(page.locator('#politica input[value="auto"]')).toBeChecked()
  const salvas = (await chamadas(page)).filter((c) => c.comando === 'save_settings')
  expect(salvas).toHaveLength(1)
  const input = (salvas[0].args as { input: { policies: Record<string, string>; web_url: string } }).input
  expect(input.policies.teams).toBe('auto')
  expect(input.policies.zoom).toBe('ask')
  expect(input.web_url).toBe('https://192.168.15.199:8443')
})
