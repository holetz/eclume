// Main flow against Prism. The mock sets no cookies and keeps no state, so the test:
// - puts the session cookies on the login and sign-up responses, as the real server would;
// - asks for the new upload with `Prefer: code=201` (the mock answers 200/deduplicated by default);
// - forwards the part PUT (absolute URL at 127.0.0.1:4010, another origin) with the credential the
//   mock requires and the CORS headers the real storage returns.
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'

// The fixtures' part URLs point at 127.0.0.1:4010; the mock may be on another port
// (ECLUME_MOCK_URL, the same as the proxy's ECLUME_API_URL).
const FIXTURE_ORIGIN = 'http://127.0.0.1:4010'
const MOCK = process.env.ECLUME_MOCK_URL ?? FIXTURE_ORIGIN
const SCREENS = process.env.E2E_SCREENSHOTS ? 'test-results/screens' : null
// The media fixtures of `npm run fixtures`, the same as the conversion browser test.
const FIXTURES = path.join('src', 'lib', 'media-convert', '__fixtures__')

async function screenshot(page: Page, name: string) {
  if (!SCREENS) return
  await page.screenshot({ path: `${SCREENS}/${name}-claro.png`, fullPage: true })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.screenshot({ path: `${SCREENS}/${name}-escuro.png`, fullPage: true })
  await page.emulateMedia({ colorScheme: 'light' })
}

test.beforeEach(async ({ page, baseURL }) => {
  await page.route(/\/api\/v1\/auth\/(login|signup)$/, async (route) => {
    const response = await route.fetch()
    if (response.status() === 204) {
      await page.context().addCookies([
        { name: 'eclume_session', value: 'e2e', url: baseURL! },
        { name: 'eclume_csrf', value: 'csrf-e2e', url: baseURL! },
      ])
    }
    await route.fulfill({ response })
  })
  await page.route('**/api/v1/uploads', (route) =>
    route.request().method() === 'POST'
      ? route.continue({ headers: { ...route.request().headers(), prefer: 'code=201' } })
      : route.continue(),
  )
  await page.route(`${FIXTURE_ORIGIN}/api/v1/uploads/*/parts/*`, async (route) => {
    const cors = {
      'access-control-allow-origin': baseURL!,
      'access-control-allow-methods': 'PUT',
      'access-control-allow-headers': 'content-type',
      'access-control-expose-headers': 'ETag',
    }
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    const response = await route.fetch({
      url: route.request().url().replace(FIXTURE_ORIGIN, MOCK),
      headers: { ...route.request().headers(), authorization: 'Bearer eclp_e2ee2ee2ee2ee2ee2ee2ee2ee2ee2ee2e' },
    })
    await route.fulfill({ response, headers: { ...response.headers(), ...cors } })
  })
})

/** Goes to a screen: through the sidebar or, for settings and help, through the header menus. */
async function navTo(page: Page, name: string) {
  const link = page.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name, exact: true })
  if (await link.count()) return link.click()
  const menu = name === 'Central de ajuda' ? 'Ajuda' : 'Configurações'
  await page.getByRole('banner').getByRole('button', { name: menu, exact: true }).click()
  await page.getByRole('menuitem', { name, exact: true }).click()
}

async function login(page: Page, shot?: string) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Entrar' })).toBeVisible()
  if (shot) await screenshot(page, shot)
  await page.getByLabel('E-mail').fill('mariana.couto@example.com')
  await page.getByLabel('Senha').fill('senha-de-teste')
  await page.getByRole('button', { name: 'Entrar' }).click()
}

test('create an account accepting the notice and enter the library @smoke', async ({ page }) => {
  await page.goto('/entrar')
  await page.getByRole('link', { name: 'Criar conta' }).click()
  await expect(page.getByRole('heading', { name: 'Criar sua conta' })).toBeVisible()
  await page.getByLabel('Nome').fill('Paulo Andrade')
  await page.getByLabel('E-mail').fill('paulo.andrade@example.com')
  await page.getByLabel('Senha').fill('senha-bem-longa-2026')
  const submit = page.getByRole('button', { name: 'Criar conta' })
  await submit.click()
  await expect(page.getByRole('alert')).toHaveText('Para criar a conta, falta o aceite do aviso.')
  await page.getByText('Sou responsável por pedir o consentimento das pessoas que gravo.').click()
  await submit.click()
  await expect(page.getByRole('heading', { level: 1, name: 'Biblioteca' })).toBeVisible()
})

/** A short PCM WAV (440 Hz tone), generated here: the smoke import does not depend on a proprietary codec. */
function wavTone(seconds: number, rate = 48_000): Buffer {
  const samples = seconds * rate
  const buffer = Buffer.alloc(44 + samples * 2)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + samples * 2, 4)
  buffer.write('WAVEfmt ', 8)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(rate, 24)
  buffer.writeUInt32LE(rate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(samples * 2, 40)
  for (let i = 0; i < samples; i++) buffer.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / rate)), 44 + i * 2)
  return buffer
}

// The smoke of the three engines (Chromium, WebKit and Firefox): login, library, recording with copying the
// summary and the player, and a small import. Only what does not depend on a proprietary codec.
test('smoke: sign in, library, recording with copy and player, and small import @smoke', async ({ page }, info) => {
  await login(page)
  await expect(page.getByRole('heading', { level: 1, name: 'Biblioteca' })).toBeVisible()
  await page.goto('/?visao=semana&data=2026-09-21')
  await page.getByRole('link', { name: /^Planejamento semanal/ }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Alinhamento do programa de lideranças' })).toBeVisible()

  const summary = page.getByRole('region', { name: 'Resumo', exact: true })
  await summary.getByRole('button', { name: 'Copiar com título' }).click()
  // The engine may deny the clipboard; what matters is the answer on screen, not silence.
  await expect(summary.getByText(/^(Copiado|Não deu para copiar)/)).toBeVisible()

  // The player: the engine says whether it plays Ogg Opus (recorded in the report), and the marker chip takes the
  // track to it.
  const opus = await page
    .getByLabel('Áudio da gravação')
    .evaluate((audio: HTMLAudioElement) => audio.canPlayType('audio/ogg; codecs=opus'))
  info.annotations.push({ type: 'ogg-opus', description: `${info.project.name}: canPlayType = "${opus}"` })
  await page.getByRole('group', { name: 'Marcadores' }).getByRole('button', { name: /00:00:42/ }).click()
  await expect(page.getByRole('slider', { name: 'Posição no áudio' })).toHaveAttribute('aria-valuetext', '00:00:42')

  // Small import: a 2 s WAV converted in the browser and sent.
  await page.goto('/?importar=1')
  const dialog = page.getByRole('dialog', { name: 'Importar arquivos' })
  await dialog
    .getByLabel(/Solte áudio ou vídeo aqui/)
    .setInputFiles({ name: 'tom.wav', mimeType: 'audio/wav', buffer: wavTone(2) })
  const created = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/api/v1/uploads'))
  const partPut = page.waitForRequest((r) => r.method() === 'PUT' && r.url().includes('/parts/1'), {
    timeout: 60_000,
  })
  await dialog.getByRole('button', { name: 'Enviar 1 arquivo' }).click()
  expect((await created).postDataJSON()).toMatchObject({ content_type: 'audio/ogg; codecs=opus' })
  // The conversion finished and the part went out. "Enviado" stays with Chromium's full scenario: Playwright's
  // WebKit does not pass the Blob body on in the `route.fetch` that takes the part to the mock.
  await partPut
})

test('library in the week, the month and the list, with the filter in the request', async ({ page }) => {
  await login(page, '1-login')
  // The mock neither filters nor paginates: the week of 2026-09-21 is the first example of GET /recordings.
  await page.goto('/?visao=semana&data=2026-09-21')
  await expect(page.getByText('21–27 de setembro de 2026')).toBeVisible()
  const monday = page.getByRole('list', { name: 'segunda, 21 de setembro' })
  await expect(monday.getByRole('listitem')).toHaveCount(2)
  await expect(page.getByRole('link', { name: 'Planejamento semanal, 09:00, 58 min, 2 marcadores' })).toBeVisible()
  // The week item carries the state; the link that fills it carries the name.
  const event = (name: RegExp) => page.getByRole('listitem').filter({ has: page.getByRole('link', { name }) })
  await expect(event(/^1:1 Elisa \/ Ana/)).toHaveAttribute('data-status', 'processing')
  await expect(event(/^reuniao-03\.mkv/)).toHaveAttribute('data-status', 'failed')
  await expect(event(/^Nota · Ligação do fornecedor/)).toHaveAttribute('data-kind', 'note')
  // The user account has no role: the admin panel is not in the menu, nor is import (it is the modal).
  const nav = page.getByRole('navigation', { name: 'Principal' })
  await expect(nav.getByRole('link', { name: 'Painel admin' })).toHaveCount(0)
  await expect(nav.getByRole('link', { name: 'Importar arquivo' })).toHaveCount(0)
  await screenshot(page, '2-biblioteca-semana')

  // The filter goes into the URL and into the GET /recordings query.
  const filters = page.getByRole('complementary', { name: 'Filtros' })
  const filtered = page.waitForRequest(
    (r) => r.url().includes('/api/v1/recordings?') && new URL(r.url()).searchParams.getAll('kind').join() === 'meeting',
  )
  await filters.getByText('Notas', { exact: true }).click()
  await filtered
  await expect(page).toHaveURL(/tipo=reuniao/)
  const tagged = page.waitForRequest((r) => new URL(r.url()).searchParams.get('tag') === 'programa-liderancas')
  await filters.getByRole('button', { name: 'programa-liderancas' }).click()
  await tagged
  await filters.getByRole('button', { name: 'Limpar filtros' }).click()
  await expect(page).not.toHaveURL(/tipo=/)

  await page.getByText('Mês', { exact: true }).click()
  await expect(page.getByText('Setembro de 2026')).toBeVisible()
  await expect(page.getByRole('group', { name: 'terça, 22 de setembro' }).getByRole('link')).toHaveCount(2)
  await screenshot(page, '2-biblioteca-mes')
  await page.getByRole('button', { name: 'Abrir a semana de quinta, 24 de setembro' }).click()
  await expect(page.getByText('21–27 de setembro de 2026')).toBeVisible()

  const listRequest = page.waitForRequest((r) => new URL(r.url()).searchParams.get('sort') === 'recorded_desc')
  await page.getByText('Lista', { exact: true }).click()
  await listRequest
  await expect(page.getByRole('region', { name: /sáb 26 set$/ })).toBeVisible()
  await screenshot(page, '2-biblioteca-lista')
})

test('Importar modal reads the date from the metadata, converts and sends', async ({ page }) => {
  await login(page)
  await page.goto('/?visao=semana&data=2026-09-21')
  await page.getByRole('button', { name: 'Importar arquivos' }).click()
  const dialog = page.getByRole('dialog', { name: 'Importar arquivos' })
  await expect(dialog).toBeVisible()
  await expect(page).toHaveURL(/importar=1/)
  // audio.m4a from `npm run fixtures`: creation_time 2026-09-19T14:02:00Z, read before the conversion.
  await dialog.getByLabel(/Solte áudio ou vídeo aqui/).setInputFiles(path.join(FIXTURES, 'audio.m4a'))
  const date = dialog.getByLabel('Início da gravação de audio.m4a')
  await expect(date).toHaveValue('2026-09-19T11:02')
  await expect(dialog.getByText('Dos metadados do arquivo')).toBeVisible()
  await expect(dialog.getByText('0:10')).toBeVisible()
  await screenshot(page, '3-importar')

  const created = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/api/v1/uploads'))
  const partPut = page.waitForRequest((r) => r.method() === 'PUT' && r.url().includes('/parts/1'))
  await dialog.getByRole('button', { name: 'Enviar 1 arquivo' }).click()
  const body = (await created).postDataJSON()
  expect(body).toMatchObject({ recorded_at: '2026-09-19T14:02:00.000Z', recorded_at_source: 'file_metadata' })
  expect(body).not.toHaveProperty('title')
  expect((await partPut).postDataBuffer()?.subarray(0, 4).toString()).toBe('OggS')
  await expect(dialog.getByText(/Enviado ·/)).toBeVisible({ timeout: 60_000 })
  await expect(dialog.getByRole('link', { name: 'Abrir' })).toHaveAttribute('href', /^\/gravacoes\/[0-9a-f-]{36}$/)
  await dialog.getByRole('button', { name: 'Fechar' }).last().click()
  await expect(dialog).toBeHidden()

  // The old route opens the modal over the library.
  await page.goto('/importar')
  await expect(page).toHaveURL(/\/\?importar=1$/)
  await expect(page.getByRole('dialog', { name: 'Importar arquivos' })).toBeVisible()
})

test('recording centered on the summary: pipeline, markers, transcript, editing, chat, export and delete', async ({
  page,
}) => {
  // The chat answer, polled by the id of the queued message, comes back ready with the same id.
  await page.route('**/api/v1/summary-chat-messages/*', async (route) => {
    const response = await route.fetch()
    const done = await response.json()
    const id = new URL(route.request().url()).pathname.split('/').at(-1)
    await route.fulfill({ response, json: { ...done, id, content: 'Pronto: as decisões estão em tabela.' } })
  })
  await login(page)
  await page.goto('/?visao=semana&data=2026-09-21')
  await page.getByRole('link', { name: /^Planejamento semanal/ }).click()

  // The mock returns the example transcribed recording for any id.
  await expect(page.getByRole('heading', { level: 1, name: 'Alinhamento do programa de lideranças' })).toBeVisible()
  const nav = page.getByRole('navigation', { name: 'Principal' })
  await expect(nav.getByRole('link', { name: 'Biblioteca' })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('list', { name: 'Processamento' }).getByRole('listitem')).toHaveText([
    'Áudio recebido',
    'Pré-processamento',
    'Transcrição',
    'Locutores',
    'Tipo de agenda',
    'Campos',
    'Resumo',
  ])
  const summary = page.getByRole('region', { name: 'Resumo', exact: true })
  await expect(summary.getByText('Editado por você · versão 2')).toBeVisible()
  await expect(page.getByRole('region', { name: 'Campos' }).getByText('Automático').first()).toBeVisible()
  await screenshot(page, '4-gravacao')

  // The ticks and the marker chips play from there.
  await expect(page.getByRole('button', { name: 'Marcador em 00:00:42: Decisão sobre as turmas' })).toBeVisible()
  await page
    .getByRole('group', { name: 'Marcadores' })
    .getByRole('button', { name: /00:02:11/ })
    .click()
  await expect(page.getByRole('slider', { name: 'Posição no áudio' })).toHaveAttribute('aria-valuetext', '00:02:11')

  // The speakers sit in their own collapsed block, inline; open, one card per speaker.
  const speakersSummary = page.locator('details.disclosure > summary', { hasText: /^Locutores/ })
  await expect(speakersSummary.locator('.speaker')).toHaveText(['Mariana Couto', 'Locutor 2', 'Locutor 3'])
  await expect(page.getByRole('region', { name: 'Campos' }).getByRole('group', { name: 'Locutores' })).toHaveCount(0)
  await speakersSummary.click()
  await expect(page.getByRole('region', { name: 'Locutores' }).locator('ul').first().locator(':scope > li')).toHaveCount(3)
  await speakersSummary.click()

  // The collapsed transcript opens with the marker before the segment.
  await page.locator('details.disclosure > summary', { hasText: /^Transcrição/ }).click()
  const segmentList = page.getByRole('list', { name: 'Falas' })
  await expect(segmentList.getByRole('listitem')).toHaveCount(12)
  await expect(segmentList.getByRole('group', { name: 'Marcador em 00:00:42' })).toContainText('Decisão sobre as turmas')
  await screenshot(page, '5-gravacao-marcadores')

  // Summary editing: saving sends the open version.
  await summary.getByRole('button', { name: 'Editar' }).click()
  const editor = page.getByRole('region', { name: 'Editando o resumo' })
  await editor.getByRole('textbox', { name: 'Resumo em Markdown' }).fill('# Ata curta')
  const saved = page.waitForRequest((r) => r.method() === 'PUT' && r.url().endsWith('/summary'))
  await editor.getByRole('button', { name: 'Salvar' }).click()
  expect((await saved).postDataJSON()).toEqual({ content_md: '# Ata curta', base_version: 2 })
  await expect(editor).toBeHidden()

  // Chat: the request enters the queue and the answer arrives through polling.
  const chat = page.getByRole('complementary', { name: 'Ajustar o resumo' })
  await chat.getByRole('textbox', { name: 'Pedido de ajuste' }).fill('Liste as decisões em tabela.')
  await chat.getByRole('button', { name: 'Enviar' }).click()
  await expect(chat.getByText('Pronto: as decisões estão em tabela.')).toBeVisible()

  // Export downloads through fetch.
  await page.getByRole('button', { name: 'Exportar' }).click()
  const download = page.waitForEvent('download')
  await page.getByRole('menuitem', { name: /Transcrição e resumo/ }).click()
  expect((await download).suggestedFilename()).toMatch(/\.docx$/)

  // Delete returns to the library it came from, with the notice.
  await page.getByRole('button', { name: 'Excluir', exact: true }).click()
  const confirm = page.getByRole('dialog', { name: 'Excluir a gravação?' })
  await confirm.getByRole('button', { name: 'Excluir' }).click()
  await expect(page.getByText('Gravação excluída.')).toBeVisible()
  await expect(page).toHaveURL(/visao=semana&data=2026-09-21/)
})

test('protected summary draft: leaving asks for confirmation and reloading finds the text again', async ({ page }) => {
  await login(page)
  await page.goto('/?visao=semana&data=2026-09-21')
  await page.getByRole('link', { name: /^Planejamento semanal/ }).click()
  const summary = page.getByRole('region', { name: 'Resumo', exact: true })
  await summary.getByRole('button', { name: 'Editar' }).click()
  const editor = page.getByRole('region', { name: 'Editando o resumo' })
  await editor.getByRole('textbox', { name: 'Resumo em Markdown' }).fill('# Rascunho que não se perde')

  // Leaving through the bar asks for confirmation; continuing to edit keeps the text.
  await navTo(page, 'Biblioteca')
  const confirm = page.getByRole('dialog', { name: 'Descartar a edição?' })
  await confirm.getByRole('button', { name: 'Continuar editando' }).click()
  await expect(confirm).toBeHidden()
  await expect(editor.getByRole('textbox')).toHaveValue('# Rascunho que não se perde')

  // Reloading the tab (accepting the browser warning) and reopening the editor brings the draft back.
  await expect
    .poll(() => page.evaluate(() => Object.keys(sessionStorage).some((k) => k.startsWith('eclume-resumo-rascunho:'))))
    .toBe(true)
  page.on('dialog', (dialog) => dialog.accept())
  await page.reload()
  await summary.getByRole('button', { name: 'Editar' }).click()
  await expect(editor.getByRole('textbox')).toHaveValue('# Rascunho que não se perde')
})

test('long transcript: ?t= takes to the segment inside its own area, the audio scrolls only it and pause stays in view', async ({
  page,
}) => {
  const COUNT = 3000
  const STEP_MS = 4000
  // The mock returns the short example transcript: here it becomes 3,000 segments of 4 s.
  await page.route('**/api/v1/transcripts/*', async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    const response = await route.fetch()
    const base = await response.json()
    const segments = Array.from({ length: COUNT }, (_, index) => ({
      ...base.segments[index % base.segments.length],
      id: `fala-${index}`,
      start_ms: index * STEP_MS,
      end_ms: index * STEP_MS + STEP_MS - 1,
      text: `Fala número ${index} da reunião longa.`,
    }))
    await route.fulfill({ response, json: { ...base, segments } })
  })
  await login(page)
  await expect(page.getByRole('heading', { name: 'Biblioteca' })).toBeVisible()
  await page.goto(`/gravacoes/01928f3a-1c00-7a00-8000-000000000401?t=${1500 * STEP_MS + 100}`)

  const segmentList = page.getByRole('list', { name: 'Falas' })
  await expect(segmentList.getByRole('listitem')).toHaveCount(COUNT)
  await expect(segmentList.getByText('Fala número 1500 da reunião longa.')).toBeInViewport()
  // The distant segment is not painted, but it is in the DOM (the browser's Ctrl+F finds it).
  await expect(segmentList.getByText('Fala número 2990 da reunião longa.')).toHaveCount(1)

  // The list is an area with its own scroll, shorter than the window.
  const box = await segmentList.evaluate((el) => ({
    overflow: getComputedStyle(el).overflowY,
    height: el.clientHeight,
    content: el.scrollHeight,
  }))
  expect(box.overflow).toBe('auto')
  expect(box.height).toBeLessThan(page.viewportSize()!.height)
  expect(box.content).toBeGreaterThan(box.height)

  // With the transcript in view and the audio advancing, the list scrolls inside, the page does not move and
  // pause stays in the window.
  const play = page.getByRole('group', { name: 'Player' }).getByRole('button', { name: /^(Tocar|Pausar)$/ })
  const pageY = () => page.evaluate(() => Math.round(window.scrollY))
  const listTop = () => segmentList.evaluate((el) => el.scrollTop)
  const beforeY = await pageY()
  const beforeList = await listTop()
  for (const index of [1520, 1540, 1560]) {
    await page.getByLabel('Áudio da gravação').evaluate((audio: HTMLAudioElement, ms) => {
      Object.defineProperty(audio, 'currentTime', { configurable: true, get: () => ms / 1000, set: () => {} })
      audio.dispatchEvent(new Event('timeupdate'))
    }, index * STEP_MS + 100)
    await expect(segmentList.getByRole('listitem').nth(index).locator('.segment')).toHaveAttribute('aria-current', 'true')
    await expect(segmentList.getByText(`Fala número ${index} da reunião longa.`)).toBeInViewport()
  }
  await expect.poll(listTop).toBeGreaterThan(beforeList)
  expect(Math.abs((await pageY()) - beforeY)).toBeLessThanOrEqual(1)
  await expect(play).toBeInViewport()

  // Reading the summary, further down, the player stays fixed at the top: pause is one click away.
  const summary = page.getByRole('region', { name: 'Resumo', exact: true })
  await summary.evaluate((el) => el.scrollIntoView({ block: 'start' }))
  const top = () => summary.evaluate((el) => Math.round(el.getBoundingClientRect().top))
  const before = await top()
  await page.getByLabel('Áudio da gravação').evaluate((audio: HTMLAudioElement, ms) => {
    Object.defineProperty(audio, 'currentTime', { configurable: true, get: () => ms / 1000, set: () => {} })
    audio.dispatchEvent(new Event('timeupdate'))
  }, 1600 * STEP_MS + 100)
  await expect(segmentList.getByRole('listitem').nth(1600).locator('.segment')).toHaveAttribute('aria-current', 'true')
  expect(Math.abs((await top()) - before)).toBeLessThanOrEqual(1)
  await expect(play).toBeInViewport()
})

test('search with field chip, recording at the second, people, collections and token against the mock', async ({ page }) => {
  await login(page)
  const nav = page.getByRole('navigation', { name: 'Principal' })

  // Search: the mock returns the three "turmas" excerpts, grouped in the recording.
  await nav.getByRole('link', { name: 'Busca' }).click()
  await page.getByRole('searchbox', { name: 'Termos' }).fill('turmas')
  await page.getByRole('button', { name: 'Buscar' }).click()
  const results = page.getByRole('region', { name: 'Resultados' })
  await expect(results.getByRole('listitem')).toHaveCount(3)
  await expect(results.locator('mark').first()).toHaveText('turmas')
  await expect(page.getByText('3 trechos em 1 gravação')).toBeVisible()

  // The chip of the "Cliente" field (choice) becomes `field` in the request.
  const withField = page.waitForRequest((r) =>
    (new URL(r.url()).searchParams.get('field') ?? '').endsWith(':Serra Azul'),
  )
  await page
    .getByRole('group', { name: 'Filtros' })
    .getByRole('button', { name: /^Cliente:/ })
    .click()
  await page.getByRole('combobox', { name: 'Cliente' }).selectOption('Serra Azul')
  await page.getByRole('button', { name: 'Aplicar' }).click()
  await withField
  await expect(page).toHaveURL(/campo=/)
  await screenshot(page, '7-busca')

  // The excerpt opens the recording at the exact second, with the transcript open and the segment highlighted.
  await results.getByRole('link', { name: /Ouvir em 00:02:02/ }).click()
  await expect(page).toHaveURL(/\/gravacoes\/[0-9a-f-]{36}\?t=122500$/)
  const segmentList = page.getByRole('list', { name: 'Falas' })
  await expect(segmentList.getByRole('listitem').nth(9).locator('.segment')).toHaveAttribute('aria-current', 'true')

  // Linking speaker 3 through the combobox, in the Locutores block: the mock returns the speaker linked to Rafael Lima.
  await page.locator('details.disclosure > summary', { hasText: /^Locutores/ }).click()
  const speakers = page.getByRole('region', { name: 'Locutores' })
  await speakers.getByRole('button', { name: 'Ligar Locutor 3 a uma pessoa' }).click()
  await speakers.getByRole('combobox', { name: 'Pessoa para Locutor 3' }).fill('Rafael')
  await speakers.getByRole('option', { name: /Rafael Lima/ }).click()
  await expect(speakers.getByRole('link', { name: 'Rafael Lima' })).toBeVisible()
  await screenshot(page, '8-gravacao-no-segundo')

  // People: the table with inline registration and the person page, with their segments on their tab.
  await nav.getByRole('link', { name: 'Pessoas' }).click()
  const people = page.getByRole('table', { name: 'Pessoas' })
  await expect(people.getByRole('link')).toHaveCount(3)
  await expect(people.getByLabel('Nome da nova pessoa')).toBeVisible()
  await screenshot(page, '9-pessoas')
  await people.getByRole('link', { name: 'Rafael Lima' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Rafael Lima' })).toBeVisible()
  await page.getByRole('tab', { name: 'Falas' }).click()
  await expect(page).toHaveURL(/\?aba=falas$/)
  await expect(page.getByRole('list', { name: 'Falas da pessoa' }).getByRole('listitem')).toHaveCount(3)

  await nav.getByRole('link', { name: 'Coleções' }).click()
  await expect(page.getByRole('list', { name: 'Coleções' }).getByText('Metalúrgica Serra Azul')).toBeVisible()
  await screenshot(page, '11-colecoes')

  // Token: created through the dialog with the lumea combination; the secret shows once.
  await navTo(page, 'Tokens de acesso')
  await expect(page.getByRole('table').getByRole('row')).toHaveCount(3)
  await expect(page.getByRole('table').getByText('Aparelho · Windows')).toBeVisible()
  await page.getByRole('button', { name: 'Novo token' }).click()
  const dialog = page.getByRole('dialog', { name: 'Novo token' })
  await dialog.getByText('Escopos individuais').click()
  await dialog.getByRole('button', { name: 'lumea', exact: true }).click()
  await dialog.getByRole('button', { name: 'Criar token' }).click()
  await expect(page.getByRole('region', { name: /criado/ })).toContainText(/eclp_[A-Za-z0-9]{32,}/)
  await screenshot(page, '12-tokens')

  await navTo(page, 'App desktop')
  await expect(page.getByRole('heading', { name: 'App desktop' })).toBeVisible()
})

test('voice identification against the mock', async ({ page }) => {
  await login(page)
  const nav = page.getByRole('navigation', { name: 'Principal' })

  // Recording: the example voice suggestion, with accept and reject; reject removes the suggestion.
  await page.goto('/?visao=semana&data=2026-09-21')
  await page.getByRole('link', { name: /^Planejamento semanal/ }).click()
  await page.locator('details.disclosure > summary', { hasText: /^Locutores/ }).click()
  const speakers = page.getByRole('region', { name: 'Locutores' })
  const suggestions = speakers.getByRole('list', { name: 'Sugestões por voz para Locutor 2' })
  await expect(suggestions).toContainText('Parece ser Rafael Lima — 82%')
  await expect(speakers.getByRole('button', { name: 'Aceitar Rafael Lima para Locutor 2' })).toBeVisible()
  await screenshot(page, '15-sugestao-por-voz')
  const rejected = page.waitForRequest((r) => r.method() === 'DELETE' && r.url().includes('/speakers/S2/suggestions/'))
  await speakers.getByRole('button', { name: 'Recusar Rafael Lima para Locutor 2' }).click()
  await rejected
  await expect(suggestions).toHaveCount(0)

  // Person: the voiceprint samples on their tab, with no per-person consent; forgetting the voice asks for confirmation.
  await nav.getByRole('link', { name: 'Pessoas' }).click()
  await page.getByRole('table', { name: 'Pessoas' }).getByRole('link', { name: 'Rafael Lima' }).click()
  await page.getByRole('tab', { name: 'Amostras de voz' }).click()
  await expect(page).toHaveURL(/\?aba=amostras$/)
  const voice = page.getByRole('tabpanel')
  await expect(voice.getByRole('list', { name: 'Amostras de voz' }).getByRole('listitem')).toHaveCount(2)
  await expect(page.getByRole('main').getByText(/consentimento/i)).toHaveCount(0)
  await voice.getByRole('button', { name: 'Esquecer a voz' }).click()
  const forget = page.getByRole('dialog', { name: 'Esquecer a voz?' })
  await expect(forget).toContainText('Os vínculos já confirmados ficam.')
  await screenshot(page, '16-pessoa-voz')
  await forget.getByRole('button', { name: 'Manter' }).click()
  await expect(forget).toHaveCount(0)

})
