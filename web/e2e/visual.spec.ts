// Verificação visual contra o Design System do eclume, com o mock (Prism) do app.spec.ts:
// - afirma o estilo computado da base do DS (cores, fonte local, canto zero, tema escuro);
// - com E2E_SCREENSHOTS=1, salva as telas em claro e escuro, a 1440×900 e a 390×844, em
//   test-results/screens/app-<tela>[-movel]-<claro|escuro>.png;
// - com E2E_SCREENSHOTS=1, salva também, do design-system/ (ou de ECLUME_DS_DIR), os quadros de
//   examples/access.html e examples/library.html (ds-<quadro>-<claro|escuro>.png), para a
//   revisão lado a lado.
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
  test.skip(!SCREENS, 'só com E2E_SCREENSHOTS=1')
  await page.setViewportSize({ width: 4700, height: 1100 })
  await page.goto(pathToFileURL(path.join(DS_DIR, 'examples', 'access.html')).href)
  for (const frame of ['sign-in', 'sign-up', 'not-found']) {
    for (const { scheme, suffix } of THEMES) {
      await page.evaluate((theme) => document.documentElement.setAttribute('data-theme', theme), scheme)
      await page.locator(`#${frame} .screen`).screenshot({ path: `${SCREENS}/ds-${frame}-${suffix}.png` })
    }
  }
})

const WEEK = '/?visao=semana&data=2026-09-21'

/** Um MP4 mínimo (ftyp + moov/mvhd) com o `creation_time` dado: o import lê a data dele. */
function mp4With(iso: string): Buffer {
  const box = (type: string, body: Buffer) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(8 + body.length, 0)
    head.write(type, 4, 'latin1')
    return Buffer.concat([head, body])
  }
  const mvhd = Buffer.alloc(16)
  mvhd.writeUInt32BE(Date.parse(iso) / 1000 - Date.UTC(1904, 0, 1) / 1000, 4)
  return Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0isom', 'latin1')), box('moov', box('mvhd', mvhd))])
}

const IMPORT_FILES = [
  { name: 'kickoff-guion.m4a', mimeType: 'audio/mp4', buffer: mp4With('2026-09-19T17:02:00Z') },
  { name: 'board-sync.mp4', mimeType: 'video/mp4', buffer: mp4With('2026-09-24T19:30:00Z') },
  { name: 'meeting-03.mkv', mimeType: 'video/x-matroska', buffer: Buffer.from('sem data') },
]

/** A cor computada de uma propriedade do primeiro elemento que casa com o seletor. */
const style = (page: Page, selector: string, property: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((element, name) => getComputedStyle(element).getPropertyValue(name), property)

test('biblioteca, gravação e busca seguem as classes do DS', async ({ page }) => {
  await page.setViewportSize(DESKTOP)
  await login(page)
  await page.goto(WEEK)
  await applyScheme(page, 'light')
  await expect(page.locator('.cal-event')).toHaveCount(10)
  // A semana abre com o expediente (8–18) enchendo a grade: a hora é a altura visível dividida por 10.
  // Blocos na superfície com a régua de cima, nota pontilhada.
  const fit = await page.evaluate(() => {
    const box = document.querySelector('.cal-week')!.parentElement!
    const head = (document.querySelector('.cal-head') as HTMLElement).offsetHeight
    const hour = parseFloat(getComputedStyle(document.querySelector('.cal-week')!).getPropertyValue('--cal-hour'))
    return { hour, expected: (box.clientHeight - head) / 10 }
  })
  expect(fit.hour).toBeCloseTo(fit.expected, 0)
  expect(await style(page, '.cal-event', 'background-color')).toBe('rgb(236, 232, 226)')
  expect(await style(page, '.cal-event[data-kind="note"]', 'border-top-style')).toBe('dotted')
  expect(await style(page, '.with-filters', 'grid-template-columns')).toMatch(/ 280px$/)
  await page.getByRole('button', { name: 'Recolher filtros' }).click()
  expect(await style(page, '.with-filters', 'grid-template-columns')).toMatch(/ 48px$/)
  await page.getByRole('button', { name: 'Expandir filtros' }).click()

  await page.getByRole('link', { name: /^Planejamento semanal/ }).click()
  await expect(page.locator('.doc')).toBeVisible()
  // A gravação: documento na tipografia do DS e o chat na coluna de 340px.
  expect(await style(page, '.doc', 'font-size')).toBe('16px')
  expect(await style(page, 'aside.chat', 'width')).toBe('340px')
  expect(await style(page, '.pipeline li[data-state="done"]', 'color')).toBe('rgb(38, 36, 32)')
  expect(await style(page, '.origin', 'border-top-style')).toBe('dashed')

  await page.goto('/busca?q=turmas')
  await expect(page.locator('.segment mark').first()).toBeVisible()
  expect(await style(page, '.segment', 'grid-template-columns')).toMatch(/^132px /)
})

for (const [viewport, tag] of [
  [DESKTOP, ''],
  [MOBILE, '-movel'],
] as const) {
  test(`screenshots da biblioteca, da gravação e da busca a ${viewport.width}×${viewport.height}`, async ({ page }) => {
    test.skip(!SCREENS, 'só com E2E_SCREENSHOTS=1')
    // A linha de agora fica no sábado do quadro do DS.
    await page.clock.setFixedTime(new Date('2026-09-26T14:12:00Z'))
    await page.setViewportSize(viewport)
    await login(page)

    await page.goto(WEEK)
    await expect(page.locator('.cal-event')).toHaveCount(10)
    await shoot(page, `biblioteca-semana${tag}`)
    await page.goto('/?visao=mes&data=2026-09-21')
    await expect(page.locator('.cal-cell').first()).toBeVisible()
    await shoot(page, `biblioteca-mes${tag}`)
    await page.goto('/?visao=lista')
    await expect(page.locator('.rec-row').first()).toBeVisible()
    await shoot(page, `biblioteca-lista${tag}`)
    if (!tag) {
      await page.goto(WEEK)
      await page.getByRole('button', { name: 'Recolher filtros' }).click()
      await shoot(page, 'biblioteca-filtros-recolhidos')
      await page.getByRole('button', { name: 'Expandir filtros' }).click()
    }

    await page.goto(`${WEEK}&importar=1`)
    const dialog = page.getByRole('dialog', { name: 'Importar arquivos' })
    await dialog.getByLabel(/Solte áudio ou vídeo aqui/).setInputFiles(IMPORT_FILES)
    await expect(dialog.getByText('Dos metadados do arquivo')).toHaveCount(2)
    await shoot(page, `importar${tag}`)

    await page.goto(WEEK)
    await page.getByRole('link', { name: /^Planejamento semanal/ }).click()
    await expect(page.locator('.doc')).toBeVisible()
    await shoot(page, `gravacao${tag}`)
    await page.locator('details.disclosure > summary').click()
    await expect(page.locator('.segment-marker').first()).toBeVisible()
    await page.locator('.segment-marker').first().scrollIntoViewIfNeeded()
    await shoot(page, `gravacao-marcadores${tag}`)
    await page.locator('details.disclosure > summary').click()
    await page.getByRole('region', { name: 'Resumo', exact: true }).getByRole('button', { name: 'Editar' }).click()
    await page.getByRole('button', { name: 'Exportar' }).click()
    await expect(page.getByRole('menu')).toBeVisible()
    await shoot(page, `gravacao-edicao${tag}`)
    await page.keyboard.press('Escape')

    await page.goto('/busca?q=turmas&periodo=30d')
    await expect(page.locator('.segment mark').first()).toBeVisible()
    await shoot(page, `busca${tag}`)
  })
}

test('quadros de referência do Design System (examples/library.html)', async ({ page }) => {
  test.skip(!SCREENS, 'só com E2E_SCREENSHOTS=1')
  await page.setViewportSize({ width: 4700, height: 2100 })
  await page.goto(pathToFileURL(path.join(DS_DIR, 'examples', 'library.html')).href)
  const frames = ['library-week', 'import', 'recording', 'recording-markers', 'recording-edit', 'search']
  for (const frame of frames) {
    for (const { scheme, suffix } of THEMES) {
      await page.evaluate((theme) => document.documentElement.setAttribute('data-theme', theme), scheme)
      await page.locator(`#${frame} .screen`).screenshot({ path: `${SCREENS}/ds-${frame}-${suffix}.png` })
    }
  }
})
