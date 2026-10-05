// Fluxo principal contra o Prism. O mock não emite cookies nem guarda estado, então o teste:
// - põe os cookies de sessão na resposta do login e do cadastro, como o servidor real faria;
// - pede o upload novo com `Prefer: code=201` (o mock responde 200/deduplicado por padrão);
// - encaminha o PUT de parte (URL absoluta em 127.0.0.1:4010, outra origem) com a credencial que
//   o mock exige e os headers CORS que o armazenamento real devolve.
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'

// As URLs de parte das fixtures apontam para 127.0.0.1:4010; o mock pode estar em outra porta
// (ECLUME_MOCK_URL, a mesma do ECLUME_API_URL do proxy).
const FIXTURE_ORIGIN = 'http://127.0.0.1:4010'
const MOCK = process.env.ECLUME_MOCK_URL ?? FIXTURE_ORIGIN
const SCREENS = process.env.E2E_SCREENSHOTS ? 'test-results/screens' : null
// As fixtures de mídia de `npm run fixtures`, as mesmas do teste de navegador da conversão.
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

/** Vai a uma tela: pela barra lateral ou, para configurações e ajuda, pelos menus do cabeçalho. */
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

test('criar conta com o aceite do aviso e entrar na biblioteca @smoke', async ({ page }) => {
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

/** Um WAV PCM curto (tom de 440 Hz), gerado aqui: o import do smoke não depende de codec proprietário. */
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

// O smoke dos três motores (Chromium, WebKit e Firefox): login, biblioteca, gravação com copiar o
// resumo e o player, e um import pequeno. Só o que não depende de codec proprietário.
test('smoke: entrar, biblioteca, gravação com copiar e player, e import pequeno @smoke', async ({ page }, info) => {
  await login(page)
  await expect(page.getByRole('heading', { level: 1, name: 'Biblioteca' })).toBeVisible()
  await page.goto('/?visao=semana&data=2026-09-21')
  await page.getByRole('link', { name: /^Planejamento semanal/ }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Alinhamento do programa de lideranças' })).toBeVisible()

  const summary = page.getByRole('region', { name: 'Resumo', exact: true })
  await summary.getByRole('button', { name: 'Copiar com título' }).click()
  // O motor pode negar a área de transferência; o que importa é a resposta na tela, não o silêncio.
  await expect(summary.getByText(/^(Copiado|Não deu para copiar)/)).toBeVisible()

  // O player: o motor diz se toca Ogg Opus (registrado no relatório), e a ficha do marcador leva a
  // trilha até ele.
  const opus = await page
    .getByLabel('Áudio da gravação')
    .evaluate((audio: HTMLAudioElement) => audio.canPlayType('audio/ogg; codecs=opus'))
  info.annotations.push({ type: 'ogg-opus', description: `${info.project.name}: canPlayType = "${opus}"` })
  await page.getByRole('group', { name: 'Marcadores' }).getByRole('button', { name: /00:00:42/ }).click()
  await expect(page.getByRole('slider', { name: 'Posição no áudio' })).toHaveAttribute('aria-valuetext', '00:00:42')

  // Import pequeno: um WAV de 2 s convertido no navegador e enviado.
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
  // A conversão terminou e a parte saiu. O "Enviado" fica com o cenário completo do Chromium: o
  // WebKit do Playwright não repassa o corpo Blob no `route.fetch` que leva a parte ao mock.
  await partPut
})

test('biblioteca na semana, no mês e na lista, com o filtro na requisição', async ({ page }) => {
  await login(page, '1-login')
  // O mock não filtra nem pagina: a semana de 21/09/2026 é o primeiro exemplo de GET /recordings.
  await page.goto('/?visao=semana&data=2026-09-21')
  await expect(page.getByText('21–27 de setembro de 2026')).toBeVisible()
  const monday = page.getByRole('list', { name: 'segunda, 21 de setembro' })
  await expect(monday.getByRole('listitem')).toHaveCount(2)
  await expect(page.getByRole('link', { name: 'Planejamento semanal, 09:00, 58 min, 2 marcadores' })).toBeVisible()
  // O item da semana leva o estado; o link que o ocupa leva o nome.
  const event = (name: RegExp) => page.getByRole('listitem').filter({ has: page.getByRole('link', { name }) })
  await expect(event(/^1:1 Elisa \/ Ana/)).toHaveAttribute('data-status', 'processing')
  await expect(event(/^reuniao-03\.mkv/)).toHaveAttribute('data-status', 'failed')
  await expect(event(/^Nota · Ligação do fornecedor/)).toHaveAttribute('data-kind', 'note')
  // A conta de usuário não tem papel: o painel admin não está no menu, nem o import (é o modal).
  const nav = page.getByRole('navigation', { name: 'Principal' })
  await expect(nav.getByRole('link', { name: 'Painel admin' })).toHaveCount(0)
  await expect(nav.getByRole('link', { name: 'Importar arquivo' })).toHaveCount(0)
  await screenshot(page, '2-biblioteca-semana')

  // O filtro vai para a URL e para a query de GET /recordings.
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

test('modal Importar lê a data dos metadados, converte e envia', async ({ page }) => {
  await login(page)
  await page.goto('/?visao=semana&data=2026-09-21')
  await page.getByRole('button', { name: 'Importar arquivos' }).click()
  const dialog = page.getByRole('dialog', { name: 'Importar arquivos' })
  await expect(dialog).toBeVisible()
  await expect(page).toHaveURL(/importar=1/)
  // audio.m4a de `npm run fixtures`: creation_time 2026-09-19T14:02:00Z, lido antes da conversão.
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

  // A rota antiga abre o modal sobre a biblioteca.
  await page.goto('/importar')
  await expect(page).toHaveURL(/\/\?importar=1$/)
  await expect(page.getByRole('dialog', { name: 'Importar arquivos' })).toBeVisible()
})

test('gravação centrada no resumo: pipeline, marcadores, transcrição, edição, chat, exportar e excluir', async ({
  page,
}) => {
  // A resposta do chat, consultada pelo id da mensagem na fila, volta pronta com o mesmo id.
  await page.route('**/api/v1/summary-chat-messages/*', async (route) => {
    const response = await route.fetch()
    const done = await response.json()
    const id = new URL(route.request().url()).pathname.split('/').at(-1)
    await route.fulfill({ response, json: { ...done, id, content: 'Pronto: as decisões estão em tabela.' } })
  })
  await login(page)
  await page.goto('/?visao=semana&data=2026-09-21')
  await page.getByRole('link', { name: /^Planejamento semanal/ }).click()

  // O mock devolve a gravação transcrita do exemplo para qualquer id.
  await expect(page.getByRole('heading', { level: 1, name: 'Alinhamento do programa de lideranças' })).toBeVisible()
  const nav = page.getByRole('navigation', { name: 'Principal' })
  await expect(nav.getByRole('link', { name: 'Biblioteca' })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('list', { name: 'Processamento' }).getByRole('listitem')).toHaveText([
    'Áudio recebido',
    'Pré-processamento',
    'Transcrição',
    'Tipo de agenda',
    'Campos',
    'Resumo',
  ])
  const summary = page.getByRole('region', { name: 'Resumo', exact: true })
  await expect(summary.getByText('Editado por você · versão 2')).toBeVisible()
  await expect(page.getByRole('region', { name: 'Campos' }).getByText('Automático').first()).toBeVisible()
  await screenshot(page, '4-gravacao')

  // Os ticks e as fichas dos marcadores tocam dali.
  await expect(page.getByRole('button', { name: 'Marcador em 00:00:42: Decisão sobre as turmas' })).toBeVisible()
  await page
    .getByRole('group', { name: 'Marcadores' })
    .getByRole('button', { name: /00:02:11/ })
    .click()
  await expect(page.getByRole('slider', { name: 'Posição no áudio' })).toHaveAttribute('aria-valuetext', '00:02:11')

  // Os locutores ficam num bloco recolhido próprio, em linha; aberto, um card por locutor.
  const speakersSummary = page.locator('details.disclosure > summary', { hasText: /^Locutores/ })
  await expect(speakersSummary.locator('.speaker')).toHaveText(['Mariana Couto', 'Locutor 2', 'Locutor 3'])
  await expect(page.getByRole('region', { name: 'Campos' }).getByRole('group', { name: 'Locutores' })).toHaveCount(0)
  await speakersSummary.click()
  await expect(page.getByRole('region', { name: 'Locutores' }).locator('ul').first().locator(':scope > li')).toHaveCount(3)
  await speakersSummary.click()

  // A transcrição recolhida abre com o marcador antes da fala.
  await page.locator('details.disclosure > summary', { hasText: /^Transcrição/ }).click()
  const falas = page.getByRole('list', { name: 'Falas' })
  await expect(falas.getByRole('listitem')).toHaveCount(12)
  await expect(falas.getByRole('group', { name: 'Marcador em 00:00:42' })).toContainText('Decisão sobre as turmas')
  await screenshot(page, '5-gravacao-marcadores')

  // Edição do resumo: salvar manda a versão aberta.
  await summary.getByRole('button', { name: 'Editar' }).click()
  const editor = page.getByRole('region', { name: 'Editando o resumo' })
  await editor.getByRole('textbox', { name: 'Resumo em Markdown' }).fill('# Ata curta')
  const saved = page.waitForRequest((r) => r.method() === 'PUT' && r.url().endsWith('/summary'))
  await editor.getByRole('button', { name: 'Salvar' }).click()
  expect((await saved).postDataJSON()).toEqual({ content_md: '# Ata curta', base_version: 2 })
  await expect(editor).toBeHidden()

  // Chat: o pedido entra na fila e a resposta chega pela consulta.
  const chat = page.getByRole('complementary', { name: 'Ajustar o resumo' })
  await chat.getByRole('textbox', { name: 'Pedido de ajuste' }).fill('Liste as decisões em tabela.')
  await chat.getByRole('button', { name: 'Enviar' }).click()
  await expect(chat.getByText('Pronto: as decisões estão em tabela.')).toBeVisible()

  // Exportar baixa por fetch.
  await page.getByRole('button', { name: 'Exportar' }).click()
  const download = page.waitForEvent('download')
  await page.getByRole('menuitem', { name: /Transcrição e resumo/ }).click()
  expect((await download).suggestedFilename()).toMatch(/\.docx$/)

  // Excluir volta para a biblioteca de onde veio, com o aviso.
  await page.getByRole('button', { name: 'Excluir', exact: true }).click()
  const confirm = page.getByRole('dialog', { name: 'Excluir a gravação?' })
  await confirm.getByRole('button', { name: 'Excluir' }).click()
  await expect(page.getByText('Gravação excluída.')).toBeVisible()
  await expect(page).toHaveURL(/visao=semana&data=2026-09-21/)
})

test('rascunho do resumo protegido: sair pede confirmação e recarregar reencontra o texto', async ({ page }) => {
  await login(page)
  await page.goto('/?visao=semana&data=2026-09-21')
  await page.getByRole('link', { name: /^Planejamento semanal/ }).click()
  const summary = page.getByRole('region', { name: 'Resumo', exact: true })
  await summary.getByRole('button', { name: 'Editar' }).click()
  const editor = page.getByRole('region', { name: 'Editando o resumo' })
  await editor.getByRole('textbox', { name: 'Resumo em Markdown' }).fill('# Rascunho que não se perde')

  // Sair pela barra pede confirmação; continuar editando mantém o texto.
  await navTo(page, 'Biblioteca')
  const confirm = page.getByRole('dialog', { name: 'Descartar a edição?' })
  await confirm.getByRole('button', { name: 'Continuar editando' }).click()
  await expect(confirm).toBeHidden()
  await expect(editor.getByRole('textbox')).toHaveValue('# Rascunho que não se perde')

  // Recarregar a aba (aceitando o aviso do navegador) e reabrir a edição traz o rascunho de volta.
  await expect
    .poll(() => page.evaluate(() => Object.keys(sessionStorage).some((k) => k.startsWith('eclume-resumo-rascunho:'))))
    .toBe(true)
  page.on('dialog', (dialog) => dialog.accept())
  await page.reload()
  await summary.getByRole('button', { name: 'Editar' }).click()
  await expect(editor.getByRole('textbox')).toHaveValue('# Rascunho que não se perde')
})

test('transcrição longa: o ?t= leva à fala dentro da área própria, o áudio rola só ela e o pausar fica à vista', async ({
  page,
}) => {
  const COUNT = 3000
  const STEP_MS = 4000
  // O mock devolve a transcrição curta do exemplo: aqui ela vira 3.000 falas de 4 s.
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

  const falas = page.getByRole('list', { name: 'Falas' })
  await expect(falas.getByRole('listitem')).toHaveCount(COUNT)
  await expect(falas.getByText('Fala número 1500 da reunião longa.')).toBeInViewport()
  // A fala distante não é pintada, mas está no DOM (o Ctrl+F do navegador a acha).
  await expect(falas.getByText('Fala número 2990 da reunião longa.')).toHaveCount(1)

  // A lista é uma área com rolagem própria, mais baixa que a janela.
  const box = await falas.evaluate((el) => ({
    overflow: getComputedStyle(el).overflowY,
    height: el.clientHeight,
    content: el.scrollHeight,
  }))
  expect(box.overflow).toBe('auto')
  expect(box.height).toBeLessThan(page.viewportSize()!.height)
  expect(box.content).toBeGreaterThan(box.height)

  // Com a transcrição à vista e o áudio avançando, a lista rola por dentro, a página não se mexe e o
  // pausar continua na janela.
  const play = page.getByRole('group', { name: 'Player' }).getByRole('button', { name: /^(Tocar|Pausar)$/ })
  const pageY = () => page.evaluate(() => Math.round(window.scrollY))
  const listTop = () => falas.evaluate((el) => el.scrollTop)
  const beforeY = await pageY()
  const beforeList = await listTop()
  for (const index of [1520, 1540, 1560]) {
    await page.getByLabel('Áudio da gravação').evaluate((audio: HTMLAudioElement, ms) => {
      Object.defineProperty(audio, 'currentTime', { configurable: true, get: () => ms / 1000, set: () => {} })
      audio.dispatchEvent(new Event('timeupdate'))
    }, index * STEP_MS + 100)
    await expect(falas.getByRole('listitem').nth(index).locator('.segment')).toHaveAttribute('aria-current', 'true')
    await expect(falas.getByText(`Fala número ${index} da reunião longa.`)).toBeInViewport()
  }
  await expect.poll(listTop).toBeGreaterThan(beforeList)
  expect(Math.abs((await pageY()) - beforeY)).toBeLessThanOrEqual(1)
  await expect(play).toBeInViewport()

  // Lendo o resumo, mais abaixo, o player continua fixo no topo: pausar está a um clique.
  const summary = page.getByRole('region', { name: 'Resumo', exact: true })
  await summary.evaluate((el) => el.scrollIntoView({ block: 'start' }))
  const top = () => summary.evaluate((el) => Math.round(el.getBoundingClientRect().top))
  const before = await top()
  await page.getByLabel('Áudio da gravação').evaluate((audio: HTMLAudioElement, ms) => {
    Object.defineProperty(audio, 'currentTime', { configurable: true, get: () => ms / 1000, set: () => {} })
    audio.dispatchEvent(new Event('timeupdate'))
  }, 1600 * STEP_MS + 100)
  await expect(falas.getByRole('listitem').nth(1600).locator('.segment')).toHaveAttribute('aria-current', 'true')
  expect(Math.abs((await top()) - before)).toBeLessThanOrEqual(1)
  await expect(play).toBeInViewport()
})

test('busca com ficha de campo, gravação no segundo, pessoas, coleções e token contra o mock', async ({ page }) => {
  await login(page)
  const nav = page.getByRole('navigation', { name: 'Principal' })

  // Busca: o mock devolve os três trechos de "turmas", agrupados na gravação.
  await nav.getByRole('link', { name: 'Busca' }).click()
  await page.getByRole('searchbox', { name: 'Termos' }).fill('turmas')
  await page.getByRole('button', { name: 'Buscar' }).click()
  const results = page.getByRole('region', { name: 'Resultados' })
  await expect(results.getByRole('listitem')).toHaveCount(3)
  await expect(results.locator('mark').first()).toHaveText('turmas')
  await expect(page.getByText('3 trechos em 1 gravação')).toBeVisible()

  // A ficha do campo "Cliente" (escolha) vira `field` na requisição.
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

  // O trecho abre a gravação no segundo exato, com a transcrição aberta e a fala destacada.
  await results.getByRole('link', { name: /Ouvir em 00:02:02/ }).click()
  await expect(page).toHaveURL(/\/gravacoes\/[0-9a-f-]{36}\?t=122500$/)
  const falas = page.getByRole('list', { name: 'Falas' })
  await expect(falas.getByRole('listitem').nth(9).locator('.segment')).toHaveAttribute('aria-current', 'true')

  // Ligar o locutor 3 pelo combobox, no bloco Locutores: o mock devolve o locutor ligado a Rafael Lima.
  await page.locator('details.disclosure > summary', { hasText: /^Locutores/ }).click()
  const speakers = page.getByRole('region', { name: 'Locutores' })
  await speakers.getByRole('button', { name: 'Ligar Locutor 3 a uma pessoa' }).click()
  await speakers.getByRole('combobox', { name: 'Pessoa para Locutor 3' }).fill('Rafael')
  await speakers.getByRole('option', { name: /Rafael Lima/ }).click()
  await expect(speakers.getByRole('link', { name: 'Rafael Lima' })).toBeVisible()
  await screenshot(page, '8-gravacao-no-segundo')

  // Pessoas: a tabela com o cadastro em linha e a página da pessoa, com as falas na aba delas.
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

  // Token: criado pelo diálogo com a combinação do lumea; o segredo aparece uma vez.
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

test('identificação por voz contra o mock', async ({ page }) => {
  await login(page)
  const nav = page.getByRole('navigation', { name: 'Principal' })

  // Gravação: a sugestão por voz do exemplo, com aceitar e recusar; recusar tira a sugestão.
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

  // Pessoa: as amostras da impressão na aba delas, sem consentimento por pessoa; esquecer a voz pede confirmação.
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
