// Fluxo principal contra o Prism. O mock não emite cookies nem guarda estado, então o teste:
// - põe os cookies de sessão na resposta do login e do cadastro, como o servidor real faria;
// - pede o upload novo com `Prefer: code=201` (o mock responde 200/deduplicado por padrão);
// - encaminha o PUT de parte (URL absoluta em 127.0.0.1:4010, outra origem) com a credencial que
//   o mock exige e os headers CORS que o armazenamento real devolve.
import { expect, test, type Page } from '@playwright/test'

// As URLs de parte das fixtures apontam para 127.0.0.1:4010; o mock pode estar em outra porta
// (ECLUME_MOCK_URL, a mesma do ECLUME_API_URL do proxy).
const FIXTURE_ORIGIN = 'http://127.0.0.1:4010'
const MOCK = process.env.ECLUME_MOCK_URL ?? FIXTURE_ORIGIN
const SCREENS = process.env.E2E_SCREENSHOTS ? 'test-results/screens' : null

/** WAV mono 16 bits de `seconds` segundos, um tom de 440 Hz. */
function wav(seconds: number, rate = 48_000): Buffer {
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
  for (let i = 0; i < samples; i++) {
    buffer.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), 44 + i * 2)
  }
  return buffer
}

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

/** Clica num item da navegação principal, abrindo "Configurações e ajuda" quando ele está recolhido. */
async function navTo(page: Page, name: string) {
  const link = page.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name })
  if (!(await link.isVisible())) await page.getByText('Configurações e ajuda').click()
  await link.click()
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
  await expect(page.getByRole('list', { name: 'Gravações' })).toBeVisible()
})

test('login, biblioteca, transcrição, import e token contra o mock', async ({ page }) => {
  await login(page, '1-login')

  // Biblioteca: as duas gravações da fixture, uma em processamento; sem filtro de compartilhadas.
  const library = page.getByRole('list', { name: 'Gravações' })
  await expect(page.getByRole('radio', { name: /Compartilhadas/ })).toHaveCount(0)
  // A conta de usuário não tem papel: o painel admin não está no menu.
  await expect(page.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name: 'Painel admin' })).toHaveCount(0)
  await expect(library.getByRole('listitem')).toHaveCount(2)
  await expect(library.getByText('Transcrevendo')).toBeVisible()
  await expect(library.getByText('Separando locutores')).toBeVisible()
  await screenshot(page, '2-biblioteca')

  // Transcrição de 3 locutores: clicar numa fala a destaca.
  await library.getByRole('link', { name: 'Alinhamento do programa de lideranças' }).click()
  const falas = page.getByRole('list', { name: 'Falas' })
  await expect(falas.getByRole('listitem')).toHaveCount(12)
  await falas.getByRole('button', { name: /Ouvir a partir de 00:39/ }).click()
  await expect(falas.getByRole('listitem').nth(3)).toHaveAttribute('aria-current', 'true')
  await expect(page.getByRole('list', { name: 'Resumos gerados' }).getByText('Reunião de equipe')).toBeVisible()

  // Renomear: o mock devolve o locutor 2 ligado a Rafael Lima.
  const speakers = page.getByRole('region', { name: 'Locutores' })
  await speakers.getByRole('button', { name: 'Renomear Locutor 2' }).click()
  await speakers.getByLabel('Novo nome de Locutor 2').fill('Rafael')
  await speakers.getByRole('button', { name: 'Salvar' }).click()
  await expect(speakers.getByRole('link', { name: 'Rafael Lima' })).toBeVisible()
  await screenshot(page, '3-transcricao')

  // Import: conversão real no navegador e upload create → PUT → complete.
  await navTo(page, 'Importar arquivo')
  await page.getByLabel('Escolher arquivo').setInputFiles({ name: 'reuniao.wav', mimeType: 'audio/wav', buffer: wav(3) })
  await expect(page.getByText(/Duração 3 s/)).toBeVisible()
  await expect(page.getByLabel('Título da gravação')).toHaveValue('reuniao')
  await screenshot(page, '4-import')
  const partPut = page.waitForRequest((r) => r.method() === 'PUT' && r.url().includes('/parts/1'))
  await page.getByRole('button', { name: 'Converter e enviar' }).click()
  await expect(page.getByText('Arquivo enviado. A transcrição entrou na fila.')).toBeVisible({ timeout: 60_000 })
  const put = await partPut
  expect(put.postDataBuffer()?.subarray(0, 4).toString()).toBe('OggS')
  await expect(page.getByRole('link', { name: 'Acompanhar a gravação' })).toHaveAttribute(
    'href',
    /^\/gravacoes\/[0-9a-f-]{36}$/,
  )

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
  await screenshot(page, '5-tokens')

  await navTo(page, 'App desktop')
  await expect(page.getByRole('heading', { name: 'App desktop' })).toBeVisible()
  await screenshot(page, '6-desktop')
})

test('busca, gravação no segundo, pessoas e coleções contra o mock', async ({ page }) => {
  await page.goto('/entrar')
  await page.getByLabel('E-mail').fill('mariana.couto@example.com')
  await page.getByLabel('Senha').fill('senha-de-teste')
  await page.getByRole('button', { name: 'Entrar' }).click()
  const nav = page.getByRole('navigation', { name: 'Principal' })

  // Busca: o mock devolve os três trechos de "turmas", com o termo destacado.
  await nav.getByRole('link', { name: 'Busca' }).click()
  await page.getByLabel('Termos').fill('turmas')
  await page.getByRole('button', { name: 'Buscar' }).click()
  const results = page.getByRole('list', { name: 'Resultados' })
  await expect(results.getByRole('listitem')).toHaveCount(3)
  await expect(results.locator('mark').first()).toHaveText('turmas')
  await expect(page).toHaveURL(/\/busca\?q=turmas$/)
  await screenshot(page, '7-busca')

  // O trecho abre a gravação no segundo exato, com a fala destacada.
  await results.getByRole('link').first().click()
  await expect(page).toHaveURL(/\/gravacoes\/[0-9a-f-]{36}\?t=122500$/)
  const falas = page.getByRole('list', { name: 'Falas' })
  await expect(falas.getByRole('listitem').nth(9)).toHaveAttribute('aria-current', 'true')
  await expect(page.getByRole('region', { name: 'Organização' }).getByLabel('Cliente')).toHaveValue('Metalúrgica Serra Azul')

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
  await screenshot(page, '10-pessoa')

  await nav.getByRole('link', { name: 'Coleções' }).click()
  await expect(page.getByRole('list', { name: 'Coleções' }).getByText('Metalúrgica Serra Azul')).toBeVisible()
  await screenshot(page, '11-colecoes')
})

test('identificação por voz contra o mock', async ({ page }) => {
  await login(page)
  const nav = page.getByRole('navigation', { name: 'Principal' })

  // Gravação: a sugestão por voz do exemplo, com aceitar e recusar; recusar tira a sugestão.
  await page.getByRole('list', { name: 'Gravações' }).getByRole('link', { name: 'Alinhamento do programa de lideranças' }).click()
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
