// Fluxo principal contra o Prism. O mock não emite cookies nem guarda estado, então o teste:
// - põe os cookies de sessão na resposta do login, como o servidor real faria;
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
  await page.route('**/api/v1/auth/login', async (route) => {
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

async function login(page: Page, shot?: string) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Entrar' })).toBeVisible()
  if (shot) await screenshot(page, shot)
  await page.getByLabel('E-mail').fill('mariana.couto@example.com')
  await page.getByLabel('Senha').fill('senha-de-teste')
  await page.getByRole('button', { name: 'Entrar' }).click()
}

test('login, biblioteca, transcrição, import e token contra o mock', async ({ page }) => {
  await login(page, '1-login')

  // Biblioteca: as duas gravações da fixture, uma em processamento.
  const library = page.getByRole('list', { name: 'Gravações' })
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
  await expect(page.getByRole('list', { name: 'Resumos gerados' }).getByText('Ata de reunião')).toBeVisible()

  // Renomear: o mock devolve o locutor 2 ligado a Rafael Lima.
  const speakers = page.getByRole('region', { name: 'Locutores' })
  await speakers.getByRole('button', { name: 'Renomear Locutor 2' }).click()
  await speakers.getByLabel('Novo nome de Locutor 2').fill('Rafael')
  await speakers.getByRole('button', { name: 'Salvar' }).click()
  await expect(speakers.getByText('Rafael Lima')).toBeVisible()
  await screenshot(page, '3-transcricao')

  // Import: conversão real no navegador e upload create → PUT → complete.
  await page.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name: 'Importar arquivo' }).click()
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

  // Token: o segredo aparece uma vez.
  await page.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name: 'Tokens de acesso' }).click()
  await expect(page.getByRole('table').getByRole('row')).toHaveCount(3)
  await page.getByRole('button', { name: 'lumea', exact: true }).click()
  await page.getByRole('button', { name: 'Criar token' }).click()
  await expect(page.getByLabel('Token', { exact: true })).toHaveValue(/^eclp_[A-Za-z0-9]{32,}$/)
  await screenshot(page, '5-tokens')

  await page.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name: 'App desktop' }).click()
  await expect(page.getByRole('heading', { name: 'App desktop' })).toBeVisible()
  await screenshot(page, '6-desktop')
})

test('painel admin contra o mock', async ({ page }) => {
  await login(page)
  await page.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name: 'Painel admin' }).click()
  const tabs = page.getByRole('navigation', { name: 'Seções da administração' })

  // Transcrição: a configuração do exemplo, salva de volta.
  await expect(page.getByRole('heading', { name: 'Transcrição' })).toBeVisible()
  await expect(page.getByLabel('Modelo', { exact: true })).toHaveValue('large-v3-turbo')
  await page.getByRole('button', { name: 'Salvar configuração' }).click()
  await expect(page.getByText('Configuração salva.')).toBeVisible()
  await screenshot(page, '7-admin-transcricao')

  // Saúde: GPU e jobs do exemplo.
  await tabs.getByRole('link', { name: 'Saúde' }).click()
  await expect(page.getByText('NVIDIA GeForce GTX 1660 SUPER')).toBeVisible()
  await expect(page.getByRole('row', { name: /Reunião de alinhamento — cliente Aurora/ })).toBeVisible()
  await screenshot(page, '8-admin-saude')

  // Segredos: só escrita.
  await tabs.getByRole('link', { name: 'Segredos' }).click()
  const hf = page.getByRole('form', { name: 'Token do Hugging Face' })
  await expect(hf.getByText('Definido')).toBeVisible()
  await hf.getByLabel('Novo valor').fill('hf_e2e_token')
  await hf.getByRole('button', { name: 'Salvar' }).click()
  await expect(hf.getByText('Token do Hugging Face salvo.')).toBeVisible()
  await expect(hf.getByLabel('Novo valor')).toHaveValue('')

  // Usuários: a lista do exemplo e o convite com link mostrado uma vez.
  await tabs.getByRole('link', { name: 'Usuários e convites' }).click()
  await expect(page.getByRole('row', { name: /Paulo Andrade/ })).toBeVisible()
  const invite = page.getByRole('form', { name: 'Novo convite' })
  await invite.getByLabel('E-mail').fill('beatriz.nunes@example.com')
  await invite.getByRole('button', { name: 'Criar convite' }).click()
  await expect(page.getByLabel('Link do convite')).toHaveValue(/\/convite\//)
  await screenshot(page, '9-admin-usuarios')
})
