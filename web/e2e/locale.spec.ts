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

test.describe('the admin panel with the browser in English', () => {
  test.use({ locale: 'en-US' })

  test('the admin login and the sections read in English', async ({ page, baseURL }) => {
    // The same admin cookies admin.spec.ts puts on the login response: the mock sets none.
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
    await page.goto('/admin/usuarios')
    await expect(page.getByRole('heading', { name: 'Sign in as admin' })).toBeVisible()
    await page.getByLabel('Email').fill('admin@example.com')
    await page.getByLabel('Password').fill('senha-do-admin')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()

    await expect(page.getByRole('heading', { level: 1, name: 'Users' })).toBeVisible()
    const nav = page.getByRole('navigation', { name: 'Platform' })
    for (const [section, heading] of [
      ['Audio preprocessing', 'Audio preprocessing'],
      ['Transcription', 'Transcription'],
      ['Speakers', 'Speakers'],
      ['Agents', 'Agents'],
      ['Default agenda types', 'Default agenda types'],
      ['Health', 'Health'],
    ] as const) {
      await nav.getByRole('link', { name: section }).click()
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
    }
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  })
})

test.describe('an English account in the agent, automation and help', () => {
  test.use({ locale: 'en-US' })

  test('the agent, the automatic processing and the help center read in English', async ({ page, baseURL }) => {
    await session(page, baseURL!, 'en')
    await page.goto('/entrar')
    await login(page, { email: 'Email', password: 'Password', submit: 'Log in' })
    await expect(page.getByRole('heading', { level: 1, name: 'Library' })).toBeVisible()

    // The Agent: a new conversation, its composer and the recent conversations.
    await page.goto('/agente')
    await expect(page.getByRole('heading', { level: 1, name: 'New conversation' })).toBeVisible()
    await expect(page.getByRole('navigation', { name: 'Recent conversations' })).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Question' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible()
    await page.goto('/agente/habilidades')
    await expect(page.getByRole('heading', { level: 1, name: 'Skills' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'New skill' })).toBeVisible()

    // Automatic processing: the steps in pipeline order.
    await page.goto('/config/automacao')
    await expect(page.getByRole('heading', { level: 1, name: 'Automatic processing' })).toBeVisible()
    await expect(
      page.getByRole('list', { name: 'Steps of the automatic processing' }).getByRole('listitem').first(),
    ).toContainText('1. Preprocessing and transcription')

    // The help center chrome: the topics, the questions and the search field.
    await page.goto('/ajuda')
    await expect(page.getByRole('heading', { level: 1, name: 'Help center' })).toBeVisible()
    await expect(page.getByRole('region', { name: 'First steps' })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Frequently asked questions' })).toBeVisible()
    await expect(page.getByRole('searchbox', { name: 'Search the help' })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  })
})
