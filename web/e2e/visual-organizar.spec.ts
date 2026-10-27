// Visual check of Organizar, Minhas configurações and Ajuda against the Design System, with the mock:
// - asserts the computed style (zero radius on .qr-slot and on the panels, black QR on white in dark,
//   the DS .list-row and .table, .help-drawer fixed on the right, no external request);
// - with E2E_SCREENSHOTS=1, saves the screens in light and dark, at 1440×900 and 390×844, in
//   test-results/screens/app-<screen>[-movel]-<claro|escuro>.png;
// - with E2E_SCREENSHOTS=1, also saves, from design-system/ (or from ECLUME_DS_DIR), the frames of
//   examples/organize.html, settings.html, mobile.html and help.html (ds-<frame>-<claro|escuro>.png).
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'

const SCREENS = process.env.E2E_SCREENSHOTS ? 'test-results/screens' : null
// The Design System versioned in design-system/; ECLUME_DS_DIR points at another export, if needed.
const DS_DIR = process.env.ECLUME_DS_DIR ?? fileURLToPath(new URL('../../design-system', import.meta.url))
const DESKTOP = { width: 1440, height: 900 }
const MOBILE = { width: 390, height: 844 }
const THEMES = [
  { scheme: 'light', suffix: 'claro' },
  { scheme: 'dark', suffix: 'escuro' },
] as const

const DS_FRAMES = {
  organize: ['people', 'person', 'fields', 'agendas'],
  settings: ['mcp', 'tokens', 'desktop-app'],
  mobile: ['m-web-qr'],
  help: ['center', 'article', 'hint', 'drawer'],
} as const

test.beforeEach(async ({ page, baseURL }) => {
  // The mock sets no cookies: a successful login gets the cookies the real server would set.
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

/** The mock only has the "usado" example of the code state: here the code stays pending. */
async function keepPairingPending(page: Page) {
  await page.route('**/api/v1/devices/pairing-codes/*', async (route) => {
    const response = await route.fetch()
    await route.fulfill({ response, json: { ...(await response.json()), status: 'pending', token_id: null } })
  })
}

/** The mock example expires on a fixed date: the created code now expires 10 minutes from now. */
async function freshPairingCodes(page: Page) {
  await page.route('**/api/v1/devices/pairing-codes', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    const response = await route.fetch()
    const body = { ...(await response.json()), expires_at: new Date(Date.now() + 600_000).toISOString() }
    await route.fulfill({ response, json: body, headers: { ...response.headers(), date: new Date().toUTCString() } })
  })
}

async function login(page: Page) {
  await freshPairingCodes(page)
  await keepPairingPending(page)
  await page.goto('/entrar')
  await page.getByLabel('E-mail').fill('mariana.couto@example.com')
  await page.getByLabel('Senha').fill('senha-de-teste')
  await page.getByRole('button', { name: 'Entrar' }).click()
  await expect(page.locator('#conteudo')).toBeVisible()
}

/** Switches the system theme and waits for the app to write the matching `data-theme`. */
async function applyScheme(page: Page, scheme: 'light' | 'dark') {
  await page.emulateMedia({ colorScheme: scheme })
  await expect(page.locator('html')).toHaveAttribute('data-theme', scheme)
}

async function shoot(page: Page, name: string, mobile: boolean) {
  if (!SCREENS) return
  for (const { scheme, suffix } of THEMES) {
    await applyScheme(page, scheme)
    await page.screenshot({ path: `${SCREENS}/app-${name}${mobile ? '-movel' : ''}-${suffix}.png`, fullPage: true })
  }
  await applyScheme(page, 'light')
}

const computed = (page: Page, selector: string, property: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((element, name) => getComputedStyle(element).getPropertyValue(name), property)

/** Waits for the loaded screen: the h1 and no "Carregando…" or "Gerando…". */
async function ready(page: Page, heading: string) {
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: /^(Carregando|Gerando|Procurando)/ })).toHaveCount(0)
}

test('organize, settings and help in the Design System: radii, QR, lists, table, drawer and nothing external', async ({
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
  await login(page)

  await page.goto('/app-movel')
  await ready(page, 'App móvel')
  const qr = page.getByRole('img', { name: 'Código QR para parear o celular' })
  await expect(qr).toBeVisible()
  expect(await computed(page, '.qr-slot', 'border-radius')).toBe('0px')
  await applyScheme(page, 'dark')
  expect(await computed(page, '.qr-slot', 'background-color')).toBe('rgb(255, 255, 255)')
  expect(await qr.locator('rect').evaluate((el) => getComputedStyle(el).fill)).toBe('rgb(255, 255, 255)')
  expect(await qr.locator('path').first().evaluate((el) => getComputedStyle(el).fill)).toBe('rgb(0, 0, 0)')
  await applyScheme(page, 'light')

  await page.goto('/config/mcp')
  await ready(page, 'Conexão MCP')
  expect(await computed(page, '.panel', 'border-radius')).toBe('0px')
  expect((await computed(page, '.split', 'grid-template-columns')).trim().split(/\s+/)).toHaveLength(2)

  await page.goto('/config/campos')
  await ready(page, 'Campos personalizados')
  expect(await computed(page, '.list-row', 'display')).toBe('grid')
  expect(await computed(page, '.list-row', 'border-bottom-style')).toBe('solid')

  await page.goto('/tokens')
  await ready(page, 'Tokens de acesso')
  expect(await computed(page, 'table.table', 'border-collapse')).toBe('collapse')

  await page.goto('/pessoas')
  await ready(page, 'Pessoas')
  await page.keyboard.press('?')
  const drawer = page.locator('.help-drawer')
  await expect(drawer).toContainText('Nesta página · Pessoas')
  expect(await computed(page, '.help-drawer', 'position')).toBe('fixed')
  expect(await computed(page, '.help-drawer', 'right')).toBe('0px')
  const box = await drawer.boundingBox()
  expect(Math.round(box!.x + box!.width)).toBe(DESKTOP.width)

  expect(external).toEqual([])
})

for (const viewport of [DESKTOP, MOBILE]) {
  const mobile = viewport === MOBILE
  test(`screenshots at ${viewport.width}×${viewport.height}`, async ({ page }) => {
    test.skip(!SCREENS, 'só com E2E_SCREENSHOTS=1')
    await page.setViewportSize(viewport)
    await login(page)

    const routes = [
      { name: 'pessoas', route: '/pessoas', heading: 'Pessoas' },
      { name: 'automacao', route: '/config/automacao', heading: 'Processamento automático' },
      { name: 'campos', route: '/config/campos', heading: 'Campos personalizados' },
      { name: 'tags', route: '/tags', heading: 'Tags' },
      { name: 'agendas', route: '/config/agendas', heading: 'Tipos de agenda' },
      { name: 'mcp', route: '/config/mcp', heading: 'Conexão MCP' },
      { name: 'tokens', route: '/tokens', heading: 'Tokens de acesso' },
      { name: 'app-desktop', route: '/app-desktop', heading: 'App desktop' },
      { name: 'app-movel', route: '/app-movel', heading: 'App móvel' },
      { name: 'ajuda', route: '/ajuda', heading: 'Central de ajuda' },
      { name: 'artigo', route: '/ajuda/sugestoes-por-voz', heading: 'Como funcionam as sugestões por voz' },
    ]
    for (const { name, route, heading } of routes) {
      await page.goto(route)
      await ready(page, heading)
      if (name === 'app-movel') await expect(page.getByRole('img', { name: /Código QR/ })).toBeVisible()
      // No horizontal page scroll, also at 390px.
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width)
      await shoot(page, name, mobile)
    }

    await page.goto('/pessoas')
    await ready(page, 'Pessoas')
    await page.getByRole('table', { name: 'Pessoas' }).getByRole('link').first().click()
    await expect(page.getByRole('tablist', { name: 'Sobre a pessoa' })).toBeVisible()
    await shoot(page, 'pessoa', mobile)

    await page.goto('/pessoas')
    await ready(page, 'Pessoas')
    await page.getByRole('button', { name: 'Sobre as sugestões por voz' }).click()
    await expect(page.getByRole('dialog', { name: 'Sugestões por voz' })).toBeVisible()
    await shoot(page, 'dica', mobile)

    await page.keyboard.press('Escape')
    await page.keyboard.press('?')
    await expect(page.locator('.help-drawer')).toContainText('Nesta página · Pessoas')
    await shoot(page, 'gaveta', mobile)
  })
}

test('Design System reference frames', async ({ page }) => {
  test.skip(!SCREENS, 'só com E2E_SCREENSHOTS=1')
  await page.setViewportSize({ width: 4700, height: 3200 })
  for (const [file, frames] of Object.entries(DS_FRAMES)) {
    await page.goto(pathToFileURL(path.join(DS_DIR, 'examples', `${file}.html`)).href)
    for (const frame of frames) {
      for (const { scheme, suffix } of THEMES) {
        await page.evaluate((theme) => document.documentElement.setAttribute('data-theme', theme), scheme)
        await page.locator(`#${frame}`).screenshot({ path: `${SCREENS}/ds-${frame}-${suffix}.png` })
      }
    }
  }
})
