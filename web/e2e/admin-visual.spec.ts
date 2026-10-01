// Verificação visual do painel de administração contra o Design System, com o mock (Prism):
// - afirma o estilo computado do painel (marca em tinta, selo Admin, cinco etapas, `.split`, quatro
//   `.stat`, canto zero, nenhuma requisição externa, Saúde relida em 15 s);
// - com E2E_SCREENSHOTS=1, salva as oito telas em claro e escuro, a 1440×900 e a 390×844, em
//   test-results/screens/admin-<rota>-<claro|escuro>-<largura>.png;
// - com E2E_SCREENSHOTS=1, salva também, do design-system/ (ou de ECLUME_DS_DIR), os quadros de
//   examples/admin.html (ds-admin-<quadro>.png e ds-admin-<quadro>-escuro.png), para a revisão lado a lado.
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'

const SCREENS = process.env.E2E_SCREENSHOTS ? 'test-results/screens' : null
// O Design System versionado em design-system/; ECLUME_DS_DIR aponta para outro export, se preciso.
const DS_DIR = process.env.ECLUME_DS_DIR ?? fileURLToPath(new URL('../../design-system', import.meta.url))
const DESKTOP = { width: 1440, height: 900 }
const MOBILE = { width: 390, height: 844 }
const THEMES = [
  { scheme: 'light', suffix: 'claro' },
  { scheme: 'dark', suffix: 'escuro' },
] as const

// Cada rota do painel, o h1 que prova que ela carregou e o quadro de examples/admin.html.
const SCREENS_BY_ROUTE = [
  { route: 'usuarios', heading: 'Usuários', frame: 'users' },
  { route: 'audio', heading: 'Pré-processamento de áudio', frame: 'audio' },
  { route: 'transcricao', heading: 'Transcrição', frame: 'transcription' },
  { route: 'locutores', heading: 'Locutores', frame: 'speakers' },
  { route: 'agentes', heading: 'Agentes', frame: 'agents' },
  { route: 'tipos-de-agenda', heading: 'Tipos de agenda padrão', frame: 'defaults' },
  { route: 'saude', heading: 'Saúde', frame: 'health' },
] as const

test.beforeEach(async ({ page, baseURL }) => {
  // O mock não emite cookies: o login bem-sucedido ganha os cookies que o servidor real poria.
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
})

async function adminLogin(page: Page) {
  await page.goto('/admin/entrar')
  await page.getByLabel('E-mail').fill('admin@example.com')
  await page.getByLabel('Senha').fill('senha-do-admin')
  await page.getByRole('button', { name: 'Entrar' }).click()
  await expect(page).toHaveURL(/\/admin\/usuarios$/)
}

/** Troca o tema do sistema e espera o app gravar o `data-theme` correspondente. */
async function applyScheme(page: Page, scheme: 'light' | 'dark') {
  await page.emulateMedia({ colorScheme: scheme })
  await expect(page.locator('html')).toHaveAttribute('data-theme', scheme)
}

async function shoot(page: Page, name: string, width: number) {
  if (!SCREENS) return
  for (const { scheme, suffix } of THEMES) {
    await applyScheme(page, scheme)
    await page.screenshot({ path: `${SCREENS}/admin-${name}-${suffix}-${width}.png` })
  }
  await applyScheme(page, 'light')
}

const computed = (page: Page, selector: string, property: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((element, name) => getComputedStyle(element).getPropertyValue(name), property)

test('o painel no Design System: marca em tinta, selo, etapas, split, indicadores e nada externo', async ({
  page,
  baseURL,
}) => {
  const origin = new URL(baseURL!).origin
  const external: string[] = []
  page.on('request', (request) => {
    const url = request.url()
    if (/^https?:/.test(url) && new URL(url).origin !== origin) external.push(url)
  })
  await page.setViewportSize(DESKTOP)
  await page.goto('/admin/entrar')
  await applyScheme(page, 'light')
  expect(await computed(page, '.auth-brand', 'background-color')).toBe('rgb(38, 36, 32)')
  expect(await computed(page, '.btn-primary', 'border-radius')).toBe('0px')

  await adminLogin(page)
  await expect(page.locator('.sidebar .tag-outline')).toHaveText('Admin')

  await page.goto('/admin/audio')
  await expect(page.locator('.order-list li')).toHaveCount(5)

  await page.goto('/admin/tipos-de-agenda')
  await expect(page.locator('.split form')).toBeVisible()
  const columns = await computed(page, '.split', 'grid-template-columns')
  expect(columns.trim().split(/\s+/)).toHaveLength(2)

  await page.goto('/admin/saude')
  await expect(page.locator('.stat')).toHaveCount(4)
  expect(external).toEqual([])
})

test('a Saúde relê a cada 15 s', async ({ page }) => {
  await page.clock.install()
  await page.setViewportSize(DESKTOP)
  await adminLogin(page)
  let reads = 0
  page.on('request', (request) => {
    if (request.url().endsWith('/api/v1/admin/health')) reads++
  })
  await page.getByRole('navigation', { name: 'Plataforma' }).getByRole('link', { name: 'Saúde' }).click()
  await expect(page.locator('.stat')).toHaveCount(4)
  await expect.poll(() => reads).toBe(1)
  await page.clock.runFor(15_000)
  await expect.poll(() => reads).toBe(2)
})

for (const viewport of [DESKTOP, MOBILE]) {
  test(`screenshots do painel a ${viewport.width}×${viewport.height}`, async ({ page }) => {
    test.skip(!SCREENS, 'só com E2E_SCREENSHOTS=1')
    await page.setViewportSize(viewport)
    await page.goto('/admin/entrar')
    await expect(page.getByRole('heading', { name: 'Entrar como admin' })).toBeVisible()
    await shoot(page, 'entrar', viewport.width)

    await adminLogin(page)
    for (const { route, heading } of SCREENS_BY_ROUTE) {
      await page.goto(`/admin/${route}`)
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
      // A tela carregada, sem o "Carregando…" do primeiro quadro.
      await expect(page.getByRole('status').filter({ hasText: /^Carregando/ })).toHaveCount(0)
      await shoot(page, route, viewport.width)
    }
  })
}

test('quadros de referência do Design System (examples/admin.html)', async ({ page }) => {
  test.skip(!SCREENS, 'só com E2E_SCREENSHOTS=1')
  await page.setViewportSize({ width: 4700, height: 3200 })
  await page.goto(pathToFileURL(path.join(DS_DIR, 'examples', 'admin.html')).href)
  for (const frame of ['admin-sign-in', ...SCREENS_BY_ROUTE.map((screen) => screen.frame)]) {
    for (const { scheme, suffix } of THEMES) {
      await page.evaluate((theme) => document.documentElement.setAttribute('data-theme', theme), scheme)
      const name = scheme === 'light' ? `ds-admin-${frame}` : `ds-admin-${frame}-${suffix}`
      await page.locator(`#${frame} .screen`).screenshot({ path: `${SCREENS}/${name}.png` })
    }
  }
})
