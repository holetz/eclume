// Acessibilidade das telas principais pelo axe (WCAG 2.1 A e AA), no tema claro e no escuro, contra
// o mock (Prism) como os outros E2E. O axe confere o contraste do texto renderizado; o das bordas de
// controle (1.4.11) fica com o teste de tokens do eclume.css.
import { AxeBuilder } from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']
const SCHEMES = ['light', 'dark'] as const

test.beforeEach(async ({ page, baseURL }) => {
  // O mock não emite cookies: o login bem-sucedido ganha os que o servidor real poria.
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

/** Roda o axe nos dois temas e falha listando regra, impacto e alvos de cada violação. */
async function expectAccessible(page: Page, screen: string) {
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme })
    await expect(page.locator('html')).toHaveAttribute('data-theme', scheme)
    const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze()
    const found = violations.map(
      (v) => `${screen} (${scheme}) · ${v.id} [${v.impact}]: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
    )
    expect(found).toEqual([])
  }
}

test('telas do usuário sem violação WCAG 2.1 A/AA, claro e escuro', async ({ page }) => {
  await page.goto('/entrar')
  await expect(page.getByRole('heading', { name: 'Entrar' })).toBeVisible()
  await expectAccessible(page, 'entrar')

  await page.getByLabel('E-mail').fill('mariana.couto@example.com')
  await page.getByLabel('Senha').fill('senha-de-teste')
  await page.getByRole('button', { name: 'Entrar' }).click()
  await page.goto('/?visao=semana&data=2026-09-21')
  await expect(page.getByText('21–27 de setembro de 2026')).toBeVisible()
  await expectAccessible(page, 'biblioteca')

  await page.getByRole('link', { name: /^Planejamento semanal/ }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Alinhamento do programa de lideranças' })).toBeVisible()
  await expectAccessible(page, 'gravação')

  for (const [path, title] of [
    ['/pessoas', 'Pessoas'],
    ['/busca?q=turmas', 'Busca'],
    ['/config/campos', 'Campos personalizados'],
  ] as const) {
    await page.goto(path)
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
    await expectAccessible(page, path)
  }
})

test('telas do admin sem violação WCAG 2.1 A/AA, claro e escuro', async ({ page }) => {
  await page.goto('/admin/usuarios')
  await expect(page.getByRole('heading', { name: 'Entrar como admin' })).toBeVisible()
  await page.getByLabel('E-mail').fill('admin@example.com')
  await page.getByLabel('Senha').fill('senha-do-admin')
  await page.getByRole('button', { name: 'Entrar' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Usuários' })).toBeVisible()
  await expectAccessible(page, 'admin/usuarios')

  await page.goto('/admin/saude')
  await expect(page.getByRole('heading', { level: 1, name: 'Saúde' })).toBeVisible()
  await expectAccessible(page, 'admin/saude')
})
