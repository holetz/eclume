// Ponta a ponta contra o backend real (deploy/e2e-real.sh): login, import com conversão no
// navegador, transcrição concluída pelo worker e o resumo automático gerado pelo `claude -p`.
// Nada é simulado: cookies, CSRF, URLs de parte assinadas, fila, worker e agente são os de verdade.
import { readFileSync } from 'node:fs'
import { expect, test, type APIRequestContext } from '@playwright/test'

const EMAIL = process.env.ECLUME_E2E_EMAIL ?? ''
const PASSWORD = process.env.ECLUME_E2E_PASSWORD ?? ''
const AUDIO = process.env.ECLUME_E2E_AUDIO ?? ''

/** Login pela API e CSRF do cookie: prepara o provider e o resumo automático da organização. */
async function prepareOrganization(request: APIRequestContext) {
  const login = await request.post('/api/v1/auth/login', { data: { email: EMAIL, password: PASSWORD } })
  expect(login.status()).toBe(204)
  const cookies = await request.storageState()
  const csrf = cookies.cookies.find((c) => c.name === 'eclume_csrf')?.value ?? ''
  const headers = { 'X-CSRF-Token': csrf }
  const provider = await request.post('/api/v1/admin/agent-providers', {
    headers,
    data: { name: 'Claude (servidor)', kind: 'claude-cli', model: 'sonnet' },
  })
  expect(provider.status(), await provider.text()).toBe(201)
  const settings = await request.patch('/api/v1/admin/settings', {
    headers,
    data: { summarization: { default_provider_id: (await provider.json()).id, auto_summarize: true } },
  })
  expect(settings.status(), await settings.text()).toBe(200)
}

test('login, import com conversão, transcrição e resumo contra o backend real', async ({ page, request }) => {
  expect(EMAIL && PASSWORD && AUDIO, 'defina ECLUME_E2E_EMAIL, ECLUME_E2E_PASSWORD e ECLUME_E2E_AUDIO').toBeTruthy()
  await prepareOrganization(request)

  // Login: o servidor real emite os cookies de sessão e de CSRF.
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Entrar' })).toBeVisible()
  await page.getByLabel('E-mail').fill(EMAIL)
  await page.getByLabel('Senha').fill(PASSWORD)
  await page.getByRole('button', { name: 'Entrar' }).click()
  await expect(page.getByRole('navigation', { name: 'Principal' })).toBeVisible()

  // Import: o WAV vira Opus no navegador e sobe em partes pelas URLs assinadas.
  await page.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name: 'Importar arquivo' }).click()
  await page.getByLabel('Escolher arquivo').setInputFiles({
    name: 'duas-vozes.wav',
    mimeType: 'audio/wav',
    buffer: readFileSync(AUDIO),
  })
  await expect(page.getByLabel('Título da gravação')).toHaveValue('duas-vozes')
  await page.getByRole('button', { name: 'Converter e enviar' }).click()
  await expect(page.getByText('Arquivo enviado. A transcrição entrou na fila.')).toBeVisible({ timeout: 120_000 })
  // O servidor guardou o Opus convertido, bem menor que o WAV escolhido.
  const listed = await request.get('/api/v1/recordings', { params: { limit: 1 } })
  const [recording] = (await listed.json()).items
  expect(recording.content_type).toMatch(/^audio\/ogg/)
  expect(recording.size_bytes).toBeLessThan(readFileSync(AUDIO).length / 5)

  // Transcrição: o worker de verdade processa, e a página acompanha até as falas aparecerem.
  await page.getByRole('link', { name: 'Acompanhar a gravação' }).click()
  await expect(page.getByRole('heading', { name: 'duas-vozes' })).toBeVisible()
  const falas = page.getByRole('list', { name: 'Falas' })
  await expect(falas.getByRole('listitem').first()).toBeVisible({ timeout: 6 * 60_000 })
  expect(await falas.getByRole('listitem').count()).toBeGreaterThan(0)

  // Resumo automático, gerado pelo `claude -p` do host depois da ingestão.
  const resumos = page.getByRole('list', { name: 'Resumos gerados' })
  await expect(resumos.getByText('Pronto')).toBeVisible({ timeout: 3 * 60_000 })
})
