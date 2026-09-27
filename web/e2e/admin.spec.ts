// Painel de administração contra o Prism. O mock não emite cookies nem guarda estado, então o teste:
// - põe os cookies de admin na resposta do login (o da sessão só no caminho /api/v1/admin, como o
//   servidor o define);
// - responde o PATCH de configurações com o exemplo do GET (o Prism gera valores sem sentido, que
//   entrariam no cache e estragariam a tela seguinte) e confere cada Salvar pela requisição.
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

/** Liga ou desliga um `Switch` do DS pelo rótulo: o checkbox fica escondido atrás da trilha. */
async function flip(page: Page, name: string) {
  await page.locator('label.switch').filter({ has: page.getByRole('switch', { name }) }).click()
}

/** Espera o PATCH de configurações e devolve o corpo mandado. */
function settingsPatch(page: Page) {
  return page
    .waitForRequest((r) => r.method() === 'PATCH' && r.url().endsWith('/api/v1/admin/settings'))
    .then((r) => r.postDataJSON() as Record<string, unknown>)
}

test('entrar como admin, percorrer as sete telas, salvar em cada uma e sair', async ({ page }) => {
  // O login volta à rota pedida; o painel não tem a navegação do usuário.
  await adminLogin(page, '/admin/audio')
  await expect(page).toHaveURL(/\/admin\/audio$/)
  await expect(page.getByRole('navigation', { name: 'Principal' })).toHaveCount(0)
  const nav = page.getByRole('navigation', { name: 'Plataforma' })
  await expect(nav.getByRole('link')).toHaveText(SECTIONS)
  await expect(page.locator('.sidebar .tag-outline')).toHaveText('Admin')

  // Pré-processamento: cinco etapas, 16 kHz sempre ligada; Salvar manda só `preprocessing`.
  await expect(page.getByRole('heading', { level: 1, name: 'Pré-processamento de áudio' })).toBeVisible()
  const steps = page.getByRole('list', { name: 'Etapas do pré-processamento' })
  await expect(steps.getByRole('listitem')).toHaveCount(5)
  await expect(steps.getByText('Sempre ligada')).toBeVisible()
  await flip(page, 'Separar canais estéreo')
  let patch = settingsPatch(page)
  await page.getByRole('button', { name: 'Salvar' }).click()
  expect(Object.keys(await patch)).toEqual(['preprocessing'])
  await expect(page.getByText('Configuração salva.')).toBeVisible()

  // Transcrição: o exemplo do contrato, salvo de volta só com `asr`.
  await nav.getByRole('link', { name: 'Transcrição' }).click()
  await expect(page).toHaveTitle('Transcrição — Admin eclume')
  await expect(page.getByLabel('Modelo', { exact: true })).toHaveValue('large-v3-turbo')
  await expect(page.getByLabel('Idioma')).toHaveValue('pt')
  await page.getByLabel('Modelo', { exact: true }).selectOption('large-v3')
  patch = settingsPatch(page)
  await page.getByRole('button', { name: 'Salvar' }).click()
  expect(Object.keys(await patch)).toEqual(['asr'])
  await expect(page.getByText('Configuração salva.')).toBeVisible()

  // Locutores: o token do Hugging Face só de escrita; desligar a identificação pede confirmação.
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

  // Agentes: finalidades por provider; editar manda `used_for`.
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

  // Tipos de agenda padrão: lista e painel; editar manda só o que mudou.
  await nav.getByRole('link', { name: 'Tipos de agenda padrão' }).click()
  const types = page.getByRole('list', { name: 'Tipos de agenda padrão' })
  await expect(types.getByRole('listitem')).toHaveCount(2)
  const typeForm = page.getByRole('form', { name: 'Reunião de equipe' })
  await typeForm.getByLabel('Como identificar').fill('Reunião interna recorrente da equipe.')
  const typePatch = page.waitForRequest((r) => r.method() === 'PATCH' && r.url().includes('/admin/default-agenda-types/'))
  await typeForm.getByRole('button', { name: 'Salvar' }).click()
  expect((await typePatch).postDataJSON()).toEqual({ identify: 'Reunião interna recorrente da equipe.' })

  // Saúde: quatro indicadores, as cinco etapas e os serviços; sem título de gravação.
  await nav.getByRole('link', { name: 'Saúde' }).click()
  await expect(page.locator('.stat')).toHaveCount(4)
  await expect(page.getByText('NVIDIA GeForce GTX 1660 SUPER · 6 GB')).toBeVisible()
  const stages = page.getByRole('region', { name: 'Etapas do processamento · últimas 24 h' })
  await expect(stages.getByRole('row')).toHaveCount(6)
  await expect(page.getByRole('region', { name: 'Serviços' })).toContainText('Servidor da API')
  await expect(page.getByText(/Reunião de alinhamento/)).toHaveCount(0)

  // Usuários: a lista inteira; Desativar só manda o PATCH depois da confirmação.
  await nav.getByRole('link', { name: 'Usuários' }).click()
  await expect(page.getByRole('row', { name: /Paulo Andrade/ })).toContainText('12')
  await expect(page.getByText('2 contas · 2 ativas')).toBeVisible()
  await page.getByRole('button', { name: 'Desativar Paulo Andrade' }).click()
  const deactivate = page.waitForRequest((r) => r.method() === 'PATCH' && r.url().includes('/admin/users/'))
  await page.getByRole('dialog', { name: 'Desativar Paulo Andrade?' }).getByRole('button', { name: 'Desativar' }).click()
  expect((await deactivate).postDataJSON()).toEqual({ active: false })

  // Sair volta ao login do admin.
  await page.getByRole('button', { name: 'Sair' }).click()
  await expect(page.getByRole('heading', { name: 'Entrar como admin' })).toBeVisible()
})

test('rotas antigas do painel redirecionam', async ({ page }) => {
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
