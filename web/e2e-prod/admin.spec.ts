// Painel de administração em produção, só de leitura: nenhum Salvar e nenhuma mutação além do
// login e do logout. Entra com a conta de admin, percorre as sete telas com os dados reais, vê a
// Saúde reler em 15 s, confere um redirecionamento, que a sessão de admin não abre a API do
// usuário e que o logout fecha a sessão. Os screenshots ficam em test-results/prod/.
import { expect, test, type Page } from '@playwright/test'

const EMAIL = process.env.ECLUME_ADMIN_EMAIL
const PASSWORD = process.env.ECLUME_ADMIN_PASSWORD
const SHOTS = 'test-results/prod'

const SCREENS = [
  { route: 'usuarios', heading: 'Usuários' },
  { route: 'audio', heading: 'Pré-processamento de áudio' },
  { route: 'transcricao', heading: 'Transcrição' },
  { route: 'locutores', heading: 'Locutores' },
  { route: 'agentes', heading: 'Agentes' },
  { route: 'tipos-de-agenda', heading: 'Tipos de agenda padrão' },
  { route: 'saude', heading: 'Saúde' },
] as const

async function open(page: Page, route: string, heading: string) {
  await page.getByRole('navigation', { name: 'Plataforma' }).getByRole('link', { name: heading, exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/admin/${route}$`))
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: /^Carregando/ })).toHaveCount(0)
  await expect(page.locator('.alert-error')).toHaveCount(0)
}

test('o painel de administração em produção, só de leitura', async ({ page }) => {
  test.skip(!EMAIL || !PASSWORD, 'exige ECLUME_ADMIN_EMAIL e ECLUME_ADMIN_PASSWORD')
  await page.setViewportSize({ width: 1440, height: 900 })

  await page.goto('/admin/entrar')
  await expect(page.getByRole('heading', { name: 'Entrar como admin' })).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/admin-entrar.png` })
  await page.getByLabel('E-mail').fill(EMAIL!)
  await page.getByLabel('Senha').fill(PASSWORD!)
  await page.getByRole('button', { name: 'Entrar' }).click()
  await expect(page).toHaveURL(/\/admin\/usuarios$/)
  await expect(page.locator('.sidebar-footer').getByText(EMAIL!)).toBeVisible()

  for (const { route, heading } of SCREENS.slice(0, -1)) {
    await open(page, route, heading)
    if (route === 'usuarios') {
      await expect(page.getByRole('table').getByRole('row').nth(1)).toBeVisible()
    }
    if (route === 'audio') {
      await expect(page.getByRole('list', { name: 'Etapas do pré-processamento' }).getByRole('listitem')).toHaveCount(5)
    }
    if (route === 'agentes') {
      await expect(page.getByRole('list', { name: 'Providers cadastrados' }).getByRole('listitem').first()).toBeVisible()
    }
    await page.screenshot({ path: `${SHOTS}/admin-${route}.png`, fullPage: true })
  }

  // Saúde: as cinco etapas, a API saudável e a segunda leitura em até 17 s.
  const firstRead = page.waitForResponse((r) => r.url().endsWith('/api/v1/admin/health') && r.ok())
  await open(page, 'saude', 'Saúde')
  await firstRead
  const stages = page.getByRole('region', { name: 'Etapas do processamento · últimas 24 h' })
  await expect(stages.getByRole('row')).toHaveCount(6)
  const api = page.getByRole('region', { name: 'Serviços' }).getByRole('row', { name: /Servidor da API/ })
  await expect(api).toContainText('Saudável')
  await page.screenshot({ path: `${SHOTS}/admin-saude.png`, fullPage: true })
  await page.waitForResponse((r) => r.url().endsWith('/api/v1/admin/health') && r.ok(), { timeout: 17_000 })

  // A rota antiga da voz leva a Locutores.
  await page.goto('/admin/voz')
  await expect(page).toHaveURL(/\/admin\/locutores$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Locutores' })).toBeVisible()

  // A sessão de admin não abre a API do usuário.
  expect((await page.request.get('/api/v1/me')).status()).toBe(401)
  expect((await page.request.get('/api/v1/admin/me')).status()).toBe(200)

  // Sair fecha a sessão de admin.
  await page.getByRole('button', { name: 'Sair' }).click()
  await expect(page.getByRole('heading', { name: 'Entrar como admin' })).toBeVisible()
  expect((await page.request.get('/api/v1/admin/me')).status()).toBe(401)
})
