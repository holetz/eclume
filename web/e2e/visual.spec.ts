// Verificação visual contra o Design System do eclume, com o mock (Prism) do app.spec.ts:
// - afirma o estilo computado da base do DS (cores, fonte local, canto zero, tema escuro);
// - com E2E_SCREENSHOTS=1, salva as telas em claro e escuro, a 1440×900 e a 390×844, em
//   test-results/screens/app-<tela>[-movel]-<claro|escuro>.png;
// - com ECLUME_DS_DIR apontando para o eclume-design, salva também os quadros equivalentes de
//   examples/access.html (ds-<quadro>-<claro|escuro>.png), para a revisão lado a lado.
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'

const SCREENS = process.env.E2E_SCREENSHOTS ? 'test-results/screens' : null
const DS_DIR = process.env.ECLUME_DS_DIR
const DESKTOP = { width: 1440, height: 900 }
const MOBILE = { width: 390, height: 844 }
const THEMES = [
  { scheme: 'light', suffix: 'claro' },
  { scheme: 'dark', suffix: 'escuro' },
] as const

test.beforeEach(async ({ page, baseURL }) => {
  // O mock não emite cookies: o login bem-sucedido ganha os cookies que o servidor real poria.
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
})

async function login(page: Page) {
  await page.goto('/entrar')
  await page.getByLabel('E-mail').fill('mariana.couto@example.com')
  await page.getByLabel('Senha').fill('senha-de-teste')
  await page.getByRole('button', { name: 'Entrar' }).click()
  await expect(page.locator('#conteudo')).toBeVisible()
}

/** Troca o tema do sistema e espera o app gravar o `data-theme` correspondente. */
async function applyScheme(page: Page, scheme: 'light' | 'dark') {
  await page.emulateMedia({ colorScheme: scheme })
  await expect(page.locator('html')).toHaveAttribute('data-theme', scheme)
}

async function shoot(page: Page, name: string) {
  if (!SCREENS) return
  for (const { scheme, suffix } of THEMES) {
    await applyScheme(page, scheme)
    await page.screenshot({ path: `${SCREENS}/app-${name}-${suffix}.png` })
  }
  await applyScheme(page, 'light')
}

const background = (page: Page, selector: string) =>
  page.locator(selector).evaluate((element) => getComputedStyle(element).backgroundColor)

test('a base do Design System: cores, fonte local, canto zero e nenhuma requisição externa', async ({
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
  await page.goto('/entrar')
  await applyScheme(page, 'light')

  expect(await background(page, 'body')).toBe('rgb(247, 245, 242)')
  expect(await background(page, '.auth-brand')).toBe('rgb(111, 90, 68)')
  expect(await page.locator('.btn-primary').evaluate((element) => getComputedStyle(element).borderRadius)).toBe('0px')
  expect(
    await page.evaluate(async () => {
      await document.fonts.ready
      return document.fonts.check('800 20px Archivo')
    }),
  ).toBe(true)

  await applyScheme(page, 'dark')
  expect(await background(page, 'body')).toBe('rgb(30, 28, 25)')

  await login(page)
  expect(external).toEqual([])
})

test('? abre a gaveta de ajuda', async ({ page }) => {
  await page.setViewportSize(DESKTOP)
  await login(page)
  await page.keyboard.press('?')
  await expect(page.getByRole('dialog', { name: 'Ajuda' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Ajuda' })).toBeHidden()
})

for (const [viewport, tag] of [
  [DESKTOP, ''],
  [MOBILE, '-movel'],
] as const) {
  test(`screenshots do app a ${viewport.width}×${viewport.height}`, async ({ page }) => {
    test.skip(!SCREENS, 'só com E2E_SCREENSHOTS=1')
    await page.setViewportSize(viewport)
    await page.goto('/entrar')
    await expect(page.getByRole('heading', { name: 'Entrar' })).toBeVisible()
    await shoot(page, `entrar${tag}`)

    // Preenchida como o quadro sign-up do DS, para a comparação lado a lado.
    await page.goto('/cadastro')
    await expect(page.getByRole('heading', { name: 'Criar sua conta' })).toBeVisible()
    await page.getByLabel('Nome').fill('Paulo Andrade')
    await page.getByLabel('E-mail').fill('paulo.andrade@example.com')
    await page.getByLabel('Senha').fill('senha-bem-longa-2026')
    await page.getByText('Sou responsável por pedir o consentimento das pessoas que gravo.').click()
    await shoot(page, `cadastro${tag}`)

    await login(page)
    await expect(page.getByRole('list', { name: 'Gravações' }).getByRole('listitem')).toHaveCount(2)
    await shoot(page, `biblioteca${tag}`)

    await page.keyboard.press('?')
    await expect(page.getByRole('dialog', { name: 'Ajuda' })).toBeVisible()
    await shoot(page, `gaveta${tag}`)
    await page.keyboard.press('Escape')

    await page.goto('/nao-existe')
    await expect(page.getByRole('heading', { name: 'Página não encontrada' })).toBeVisible()
    await shoot(page, `404${tag}`)
  })
}

test('quadros de referência do Design System (examples/access.html)', async ({ page }) => {
  test.skip(!SCREENS || !DS_DIR, 'só com E2E_SCREENSHOTS=1 e ECLUME_DS_DIR')
  await page.setViewportSize({ width: 4700, height: 1100 })
  await page.goto(pathToFileURL(path.join(DS_DIR!, 'examples', 'access.html')).href)
  for (const frame of ['sign-in', 'sign-up', 'not-found']) {
    for (const { scheme, suffix } of THEMES) {
      await page.evaluate((theme) => document.documentElement.setAttribute('data-theme', theme), scheme)
      await page.locator(`#${frame} .screen`).screenshot({ path: `${SCREENS}/ds-${frame}-${suffix}.png` })
    }
  }
})
