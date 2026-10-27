// Administration panel against Prism. The mock sets no cookies and keeps no state, so the test:
// - puts the admin cookies on the login response (the session one only on the /api/v1/admin path, as the
//   server defines it);
// - answers the settings PATCH with the GET example (Prism generates meaningless values, which
//   would enter the cache and break the next screen) and checks each Salvar through the request.
import { expect, test, type Page } from '@playwright/test'

const SECTIONS = [
  'Usuários',
  'Pré-processamento de áudio',
  'Transcrição',
  'Locutores',
  'Agentes',
  'Tipos de agenda padrão',
  'Saúde',
]

test.beforeEach(async ({ page, baseURL }) => {
  await page.route('**/api/v1/admin/auth/login', async (route) => {
    const response = await route.fetch()
    if (response.status() === 204) {
      const domain = new URL(baseURL!).hostname
      await page.context().addCookies([
        { name: 'eclume_admin_session', value: 'e2e-admin', domain, path: '/api/v1/admin' },
        { name: 'eclume_admin_csrf', value: 'csrf-admin-e2e', domain, path: '/' },
      ])
    }
    await route.fulfill({ response })
  })
  await page.route('**/api/v1/admin/settings', async (route) =>
    route.request().method() === 'PATCH'
      ? route.fulfill({ response: await page.request.get(route.request().url()) })
      : route.continue(),
  )
})

async function adminLogin(page: Page, path: string) {
  await page.goto(path)
  await expect(page.getByRole('heading', { name: 'Entrar como admin' })).toBeVisible()
  await page.getByLabel('E-mail').fill('admin@example.com')
  await page.getByLabel('Senha').fill('senha-do-admin')
  await page.getByRole('button', { name: 'Entrar' }).click()
}

/** Turns a DS `Switch` on or off by its label: the checkbox is hidden behind the track. */
async function flip(page: Page, name: string) {
  await page.locator('label.switch').filter({ has: page.getByRole('switch', { name }) }).click()
}

/** Waits for the settings PATCH and returns the body sent. */
function settingsPatch(page: Page) {
  return page
    .waitForRequest((r) => r.method() === 'PATCH' && r.url().endsWith('/api/v1/admin/settings'))
    .then((r) => r.postDataJSON() as Record<string, unknown>)
}

test('sign in as admin, go through the seven screens, save on each and sign out', async ({ page }) => {
  // Login returns to the requested route; the panel lacks the user navigation.
  await adminLogin(page, '/admin/audio')
  await expect(page).toHaveURL(/\/admin\/audio$/)
  await expect(page.getByRole('navigation', { name: 'Principal' })).toHaveCount(0)
  const nav = page.getByRole('navigation', { name: 'Plataforma' })
  await expect(nav.getByRole('link')).toHaveText(SECTIONS)
  await expect(page.locator('.sidebar .tag-outline')).toHaveText('Admin')

  // Preprocessing: five steps, 16 kHz always on; Salvar sends only `preprocessing`.
  await expect(page.getByRole('heading', { level: 1, name: 'Pré-processamento de áudio' })).toBeVisible()
  const steps = page.getByRole('list', { name: 'Etapas do pré-processamento' })
  await expect(steps.getByRole('listitem')).toHaveCount(5)
  await expect(steps.getByText('Sempre ligada')).toBeVisible()
  await flip(page, 'Separar canais estéreo')
  let patch = settingsPatch(page)
  await page.getByRole('button', { name: 'Salvar' }).click()
  expect(Object.keys(await patch)).toEqual(['preprocessing'])
  await expect(page.getByText('Configuração salva.')).toBeVisible()

  // Transcription: the contract example, saved back with only `asr`.
  await nav.getByRole('link', { name: 'Transcrição' }).click()
  await expect(page).toHaveTitle('Transcrição — Admin eclume')
  await expect(page.getByLabel('Modelo', { exact: true })).toHaveValue('large-v3-turbo')
  await expect(page.getByLabel('Idioma')).toHaveValue('pt')
  await page.getByLabel('Modelo', { exact: true }).selectOption('large-v3')
  patch = settingsPatch(page)
  await page.getByRole('button', { name: 'Salvar' }).click()
  expect(Object.keys(await patch)).toEqual(['asr'])
  await expect(page.getByText('Configuração salva.')).toBeVisible()

  // Speakers: the Hugging Face token is write-only; turning identification off asks for confirmation.
  await nav.getByRole('link', { name: 'Locutores' }).click()
  await expect(page.getByRole('group', { name: 'Token do Hugging Face' }).getByText('•••••••• guardado')).toBeVisible()
  await flip(page, 'Sugerir quem está falando pelas amostras de voz')
  await page.getByRole('button', { name: 'Salvar' }).click()
  const dialog = page.getByRole('dialog', { name: 'Desligar a identificação por voz?' })
  await expect(dialog).toBeVisible()
  patch = settingsPatch(page)
  await dialog.getByRole('button', { name: 'Desligar e salvar' }).click()
  expect(Object.keys(await patch).sort()).toEqual(['diarization', 'voice_identification'])
  await expect(page.getByText('Configuração salva.')).toBeVisible()

  // Agents: purposes per provider; editing sends `used_for`.
  await nav.getByRole('link', { name: 'Agentes' }).click()
  const providers = page.getByRole('list', { name: 'Providers cadastrados' })
  await expect(providers.getByRole('listitem')).toHaveCount(2)
  await expect(providers).toContainText('Claude (servidor)')
  await page.getByRole('button', { name: 'Editar DeepSeek' }).click()
  const form = page.getByRole('form', { name: 'Editar DeepSeek' })
  await form.getByLabel('Modelo').fill('deepseek-reasoner')
  const providerPatch = page.waitForRequest((r) => r.method() === 'PATCH' && r.url().includes('/admin/agent-providers/'))
  await form.getByRole('button', { name: 'Salvar' }).click()
  expect((await providerPatch).postDataJSON()).toMatchObject({ model: 'deepseek-reasoner', used_for: ['agenda_detection'] })
  await expect(form).toHaveCount(0)

  // Fallback agenda types: list and panel; editing sends only what changed.
  await nav.getByRole('link', { name: 'Tipos de agenda padrão' }).click()
  const types = page.getByRole('list', { name: 'Tipos de agenda padrão' })
  await expect(types.getByRole('listitem')).toHaveCount(2)
  const typeForm = page.getByRole('form', { name: 'Reunião de equipe' })
  await typeForm.getByLabel('Como identificar').fill('Reunião interna recorrente da equipe.')
  const typePatch = page.waitForRequest((r) => r.method() === 'PATCH' && r.url().includes('/admin/default-agenda-types/'))
  await typeForm.getByRole('button', { name: 'Salvar' }).click()
  expect((await typePatch).postDataJSON()).toEqual({ identify: 'Reunião interna recorrente da equipe.' })

  // Health: four indicators, the five steps and the services; no recording title.
  await nav.getByRole('link', { name: 'Saúde' }).click()
  await expect(page.locator('.stat')).toHaveCount(4)
  await expect(page.getByText('NVIDIA GeForce GTX 1660 SUPER · 6 GB')).toBeVisible()
  const stages = page.getByRole('region', { name: 'Etapas do processamento · últimas 24 h' })
  await expect(stages.getByRole('row')).toHaveCount(6)
  await expect(page.getByRole('region', { name: 'Serviços' })).toContainText('Servidor da API')
  await expect(page.getByText(/Reunião de alinhamento/)).toHaveCount(0)

  // Users: the whole list; Desativar only sends the PATCH after confirmation.
  await nav.getByRole('link', { name: 'Usuários' }).click()
  await expect(page.getByRole('row', { name: /Paulo Andrade/ })).toContainText('12')
  await expect(page.getByText('2 contas · 2 ativas')).toBeVisible()
  await page.getByRole('button', { name: 'Desativar Paulo Andrade' }).click()
  const deactivate = page.waitForRequest((r) => r.method() === 'PATCH' && r.url().includes('/admin/users/'))
  await page.getByRole('dialog', { name: 'Desativar Paulo Andrade?' }).getByRole('button', { name: 'Desativar' }).click()
  expect((await deactivate).postDataJSON()).toEqual({ active: false })

  // Sair returns to the admin login.
  await page.getByRole('button', { name: 'Sair' }).click()
  await expect(page.getByRole('heading', { name: 'Entrar como admin' })).toBeVisible()
})

test('old panel routes redirect', async ({ page }) => {
  await adminLogin(page, '/admin')
  await expect(page).toHaveURL(/\/admin\/usuarios$/)
  for (const [from, to, heading] of [
    ['/admin/voz', '/admin/locutores', 'Locutores'],
    ['/admin/segredos', '/admin/locutores', 'Locutores'],
    ['/admin/templates', '/admin/tipos-de-agenda', 'Tipos de agenda padrão'],
  ]) {
    await page.goto(from)
    await expect(page).toHaveURL(new RegExp(`${to}$`))
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
  }
  await page.goto('/admin/nao-existe')
  await expect(page.getByRole('heading', { name: 'Página não encontrada' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Plataforma' })).toBeVisible()
})
