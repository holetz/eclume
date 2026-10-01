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

test('criar conta com o aceite do aviso e entrar na biblioteca', async ({ page }) => {
  await page.goto('/entrar')
  await page.getByRole('link', { name: 'Criar conta' }).click()
  await expect(page.getByRole('heading', { name: 'Criar sua conta' })).toBeVisible()
  await page.getByLabel('Nome').fill('Paulo Andrade')
  await page.getByLabel('E-mail').fill('paulo.andrade@example.com')
  await page.getByLabel('Senha').fill('senha-bem-longa-2026')
  const submit = page.getByRole('button', { name: 'Criar conta' })
  await expect(submit).toBeDisabled()
  await page.getByText('Sou responsável por pedir o consentimento das pessoas que gravo.').click()
  await submit.click()
  await expect(page.getByRole('heading', { level: 1, name: 'Biblioteca' })).toBeVisible()
})

test('biblioteca na semana, no mês e na lista, com o filtro na requisição', async ({ page }) => {
  await login(page, '1-login')
  // O mock não filtra nem pagina: a semana de 21/09/2026 é o primeiro exemplo de GET /recordings.
  await page.goto('/?visao=semana&data=2026-09-21')
  await expect(page.getByText('21–27 de setembro de 2026')).toBeVisible()
  const monday = page.getByRole('list', { name: 'segunda, 21 de setembro' })
  await expect(monday.getByRole('listitem')).toHaveCount(2)
  await expect(page.getByRole('listitem', { name: 'Planejamento semanal, 09:00, 58 min, 2 marcadores' })).toBeVisible()
  await expect(page.getByRole('listitem', { name: /^1:1 Elisa \/ Ana/ })).toHaveAttribute('data-status', 'processing')
  await expect(page.getByRole('listitem', { name: /^reuniao-03\.mkv/ })).toHaveAttribute('data-status', 'failed')
  await expect(page.getByRole('listitem', { name: /^Nota · Ligação do fornecedor/ })).toHaveAttribute(
    'data-kind',
    'note',
  )
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
  await page.getByRole('listitem', { name: /^Planejamento semanal/ }).click()

  // O mock devolve a gravação transcrita do exemplo para qualquer id.
  await expect(page.getByRole('heading', { level: 1, name: 'Alinhamento do programa de lideranças' })).toBeVisible()
  const nav = page.getByRole('navigation', { name: 'Principal' })
  await expect(nav.getByRole('link', { name: 'Biblioteca' })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('list', { name: 'Processamento' }).getByRole('listitem')).toHaveText([
    'Áudio recebido',
    'Pré-processamento',
    'Transcrição',
    'Tipo de agenda',
    'Campos preenchidos',
    'Resumo pronto',
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

  // A transcrição recolhida abre com o marcador antes da fala.
  await page.locator('details.disclosure > summary').click()
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
  await page.getByRole('listitem', { name: /^Planejamento semanal/ }).click()
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

  // Ligar o locutor 3 pelo combobox: o mock devolve o locutor ligado a Rafael Lima.
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
  await page.getByRole('listitem', { name: /^Planejamento semanal/ }).click()
  await page.locator('details.disclosure > summary').click()
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
