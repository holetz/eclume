// Ponta a ponta contra o backend real (deploy/e2e-real.sh): cadastro, login, import pelo modal (data
// confirmada, conversão no navegador), transcrição concluída pelo worker e o resumo automático gerado pelo `claude -p`.
// Nada é simulado: cookies, CSRF, URLs de parte assinadas, fila, worker e agente são os de verdade.
// O admin vem do CLI (`eclume-server admin create`); o usuário nasce pelo cadastro aberto.
import { readFileSync } from 'node:fs'
import { expect, test, type APIRequestContext } from '@playwright/test'

const ADMIN_EMAIL = process.env.ECLUME_E2E_ADMIN_EMAIL ?? ''
const ADMIN_PASSWORD = process.env.ECLUME_E2E_ADMIN_PASSWORD ?? ''
const AUDIO = process.env.ECLUME_E2E_AUDIO ?? ''
const EMAIL = `e2e-${Date.now()}@eclume.invalid`
const PASSWORD = 'senha-do-cadastro-e2e'

async function csrf(request: APIRequestContext, name: string): Promise<Record<string, string>> {
  const { cookies } = await request.storageState()
  return { 'X-CSRF-Token': cookies.find((c) => c.name === name)?.value ?? '' }
}

/** Pela sessão de admin: o provider `claude-cli`, que assume todas as finalidades (resumo, campos e tipo). */
async function preparePlatform(request: APIRequestContext) {
  const login = await request.post('/api/v1/admin/auth/login', {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  })
  expect(login.status(), await login.text()).toBe(204)
  const headers = await csrf(request, 'eclume_admin_csrf')
  const provider = await request.post('/api/v1/admin/agent-providers', {
    headers,
    data: { name: 'Claude (servidor)', kind: 'claude-cli', model: 'sonnet' },
  })
  expect(provider.status(), await provider.text()).toBe(201)
}

/** Cadastro aberto com o aceite do aviso em vigor; a conta nasce com os tipos de agenda padrão. */
async function signup(request: APIRequestContext) {
  const info = await request.get('/api/v1/auth/signup')
  expect(info.status()).toBe(200)
  const { open, notice } = await info.json()
  expect(open).toBe(true)
  const created = await request.post('/api/v1/auth/signup', {
    data: { name: 'Consultora E2E', email: EMAIL, password: PASSWORD, notice_version: notice.version },
  })
  expect(created.status(), await created.text()).toBe(204)
  const me = await (await request.get('/api/v1/me')).json()
  expect(me.notice_required).toBe(false)
}

test('cadastro, login, import com conversão, transcrição e resumo contra o backend real', async ({ page, request }) => {
  expect(
    ADMIN_EMAIL && ADMIN_PASSWORD && AUDIO,
    'defina ECLUME_E2E_ADMIN_EMAIL, ECLUME_E2E_ADMIN_PASSWORD e ECLUME_E2E_AUDIO',
  ).toBeTruthy()
  await preparePlatform(request)
  await signup(request)

  // Login: o servidor real emite os cookies de sessão e de CSRF.
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Entrar' })).toBeVisible()
  await page.getByLabel('E-mail').fill(EMAIL)
  await page.getByLabel('Senha').fill(PASSWORD)
  await page.getByRole('button', { name: 'Entrar' }).click()
  await expect(page.getByRole('navigation', { name: 'Principal' })).toBeVisible()

  // Import pelo modal da biblioteca: o WAV não traz data, então a pessoa confirma o início da
  // gravação; o arquivo vira Opus no navegador e sobe em partes pelas URLs assinadas.
  await expect(page.getByRole('heading', { level: 1, name: 'Biblioteca' })).toBeVisible()
  await page.getByRole('button', { name: 'Importar arquivos' }).click()
  const dialog = page.getByRole('dialog', { name: 'Importar arquivos' })
  await dialog.getByLabel(/Solte áudio ou vídeo aqui/).setInputFiles({
    name: 'duas-vozes.wav',
    mimeType: 'audio/wav',
    buffer: readFileSync(AUDIO),
  })
  const date = dialog.getByLabel('Início da gravação de duas-vozes.wav')
  await expect(dialog.getByText('Sem data no arquivo · usando a data de modificação, confira')).toBeVisible()
  await date.fill('2026-09-21T09:30')
  await expect(dialog.getByText('Editada por você')).toBeVisible()
  await dialog.getByRole('button', { name: 'Enviar 1 arquivo' }).click()
  await expect(dialog.getByText(/Enviado ·/)).toBeVisible({ timeout: 120_000 })
  // O servidor guardou o Opus convertido, bem menor que o WAV escolhido, na data confirmada.
  const listed = await request.get('/api/v1/recordings', { params: { limit: 1 } })
  const [recording] = (await listed.json()).items
  expect(recording.content_type).toMatch(/^audio\/ogg/)
  expect(recording.size_bytes).toBeLessThan(readFileSync(AUDIO).length / 5)
  expect(recording.recorded_at_source).toBe('user')
  expect(new Date(recording.recorded_at).getTime()).toBe(new Date(2026, 8, 21, 9, 30).getTime())

  // Transcrição: o worker de verdade processa, e a página acompanha até a transcrição aparecer.
  await dialog.getByRole('link', { name: 'Abrir' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'duas-vozes' })).toBeVisible()
  const summaryLine = page.locator('details.disclosure > summary')
  await expect(summaryLine).toBeVisible({ timeout: 6 * 60_000 })
  await summaryLine.click()
  const falas = page.getByRole('list', { name: 'Falas' })
  await expect(falas.getByRole('listitem').first()).toBeVisible()

  // Resumo automático pelo tipo de agenda detectado, gerado pelo `claude -p` do host depois da ingestão.
  const resumo = page.getByRole('region', { name: 'Resumo', exact: true })
  await expect(resumo.locator('.doc')).toBeVisible({ timeout: 3 * 60_000 })
  await expect(resumo.getByText(/Do tipo de agenda · versão \d+/)).toBeVisible()
})
