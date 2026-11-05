// The UI language against Prism: the login follows the browser language, the shell and account
// settings follow the account locale, and the switcher changes the strings with no reload. The mock
// keeps no state and answers `/me` with `pt-BR`, so the test rewrites `/me` and `/me/locale` to the
// locale it plays. Sessions are the same cookies the main flow puts on the login response.
import { expect, test, type Page } from '@playwright/test'

type Locale = 'en' | 'pt-BR' | null

/** Logs in through the mock and keeps `/me` and `/me/locale` answering with `locale` (mutable). */
async function session(page: Page, baseURL: string, initial: Locale) {
  const state = { locale: initial }
  await page.route(/\/api\/v1\/auth\/login$/, async (route) => {
    const response = await route.fetch()
    if (response.status() === 204) {
      await page.context().addCookies([
        { name: 'eclume_session', value: 'e2e', url: baseURL },
        { name: 'eclume_csrf', value: 'csrf-e2e', url: baseURL },
      ])
    }
    await route.fulfill({ response })
  })
  await page.route(/\/api\/v1\/me$/, async (route) => {
    const response = await route.fetch()
    if (response.status() !== 200) return route.fulfill({ response })
    const me = await response.json()
    await route.fulfill({ response, json: { ...me, user: { ...me.user, locale: state.locale } } })
  })
  await page.route(/\/api\/v1\/me\/locale$/, async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue()
    state.locale = (route.request().postDataJSON() as { locale: Locale }).locale
    await route.fulfill({ json: { locale: state.locale, effective: state.locale ?? 'pt-BR' } })
  })
  return state
}

async function login(page: Page, labels: { email: string; password: string; submit: string }) {
  await page.getByLabel(labels.email).fill('mariana.couto@example.com')
  await page.getByLabel(labels.password).fill('senha-de-teste')
  await page.getByRole('button', { name: labels.submit, exact: true }).click()
}

test.describe('browser in English', () => {
  test.use({ locale: 'en-US' })

  test('the login reads in English, and an English account keeps the shell in English @smoke', async ({
    page,
    baseURL,
  }) => {
    await session(page, baseURL!, 'en')
    await page.goto('/entrar')
    await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await login(page, { email: 'Email', password: 'Password', submit: 'Log in' })
    const nav = page.getByRole('navigation', { name: 'Main' })
    await expect(nav.getByRole('link', { name: 'Library', exact: true })).toBeVisible()
    await expect(nav.getByText('Recordings', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible()
  })
})

test.describe('browser in Portuguese', () => {
  test.use({ locale: 'pt-BR' })

  test('the login reads in Portuguese, and a Portuguese account keeps the shell in Portuguese', async ({
    page,
    baseURL,
  }) => {
    await session(page, baseURL!, 'pt-BR')
    await page.goto('/entrar')
    await expect(page.getByRole('heading', { name: 'Entrar' })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR')
    await login(page, { email: 'E-mail', password: 'Senha', submit: 'Entrar' })
    const nav = page.getByRole('navigation', { name: 'Principal' })
    await expect(nav.getByRole('link', { name: 'Biblioteca', exact: true })).toBeVisible()
    await expect(nav.getByText('Gravações', { exact: true })).toBeVisible()
  })

  test('the account locale wins over the browser, and the switcher changes the strings with no reload', async ({
    page,
    baseURL,
  }) => {
    await session(page, baseURL!, 'en')
    await page.goto('/entrar')
    await login(page, { email: 'E-mail', password: 'Senha', submit: 'Entrar' })
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible()

    await page.goto('/config/conta')
    await expect(page.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Privacy and data' })).toBeVisible()
    // A marker on the window: a reload or a full navigation would drop it.
    await page.evaluate(() => Object.assign(window, { __noReload: true }))

    await page.getByLabel('Interface language').selectOption('pt-BR')
    await expect(page.getByRole('heading', { level: 1, name: 'Conta' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Privacidade e dados' })).toBeVisible()
    await expect(page.getByRole('navigation', { name: 'Principal' })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR')
    expect(await page.evaluate(() => (window as { __noReload?: boolean }).__noReload)).toBe(true)

    await page.getByLabel('Idioma da interface').selectOption('en')
    await expect(page.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible()
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible()
    expect(await page.evaluate(() => (window as { __noReload?: boolean }).__noReload)).toBe(true)
  })
})

test.describe('an English account across the areas', () => {
  test.use({ locale: 'en-US' })

  test('the library, a recording, search, people, organize, collections and tags read in English', async ({
    page,
    baseURL,
  }) => {
    await session(page, baseURL!, 'en')
    await page.goto('/entrar')
    await login(page, { email: 'Email', password: 'Password', submit: 'Log in' })
    const nav = page.getByRole('navigation', { name: 'Main' })

    // Library: the week of the mock fixtures, with the date range in English.
    await expect(page.getByRole('heading', { level: 1, name: 'Library' })).toBeVisible()
    await page.goto('/?visao=semana&data=2026-09-21')
    await expect(page.locator('.toolbar-title')).toHaveText('September 21–27, 2026')
    await expect(page.getByRole('button', { name: 'Next week' })).toBeVisible()

    // A recording: the pipeline steps and the regions come from the shared vocabulary.
    await page.getByRole('link', { name: /^Planejamento semanal/ }).click()
    await expect(page.getByRole('list', { name: 'Processing' }).getByRole('listitem').first()).toHaveText(
      'Audio received',
    )
    await expect(page.getByRole('region', { name: 'Fields' })).toBeVisible()

    // Search.
    await page.goto('/busca')
    await expect(page.getByRole('heading', { level: 1, name: 'Search' })).toBeVisible()
    await page.getByRole('searchbox', { name: 'Terms' }).fill('turmas')
    await page.getByRole('button', { name: 'Search', exact: true }).click()
    await expect(page.getByRole('region', { name: 'Results' }).getByRole('listitem')).toHaveCount(3)

    // People.
    await nav.getByRole('link', { name: 'People' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'People' })).toBeVisible()
    await expect(page.getByRole('table', { name: 'People' }).getByLabel('Name of the new person')).toBeVisible()

    // Organize: custom fields and agenda types.
    await page.goto('/config/campos')
    await expect(page.getByRole('heading', { level: 1, name: 'Custom fields' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'New field' })).toBeVisible()
    await page.goto('/config/agendas')
    await expect(page.getByRole('heading', { level: 1, name: 'Agenda types' })).toBeVisible()

    // Collections and tags.
    await page.goto('/colecoes')
    await expect(page.getByRole('heading', { level: 1, name: 'Collections' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'New collection' })).toBeVisible()
    await page.goto('/tags')
    await expect(page.getByRole('heading', { level: 1, name: 'Tags' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'New tag' })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  })
})
