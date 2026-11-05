import { test, expect, calls } from './fixtures'
import type { Page } from '@playwright/test'

type Locale = 'en' | 'pt-BR'
type Mock = {
  state: { status: { locale: Locale } }
  emit: (event: string) => void
}

const copy = {
  en: {
    help: 'Help', settings: 'Settings', recent: 'Recent',
    menu: ['First steps', 'Microphone permissions', 'Synced folder',
      /Keyboard shortcuts\s*Ctrl\+\//, /Open the help center\s*↗/,
      /Report a problem…\s*Attach eclume\.log/],
    shortcuts: 'Keyboard shortcuts',
    global: ['Start / stop recording', 'New voice note', 'Add marker'],
    window: ['Import file', 'Settings', 'Keyboard shortcuts'],
    tabs: ['General', 'Meetings', 'Audio', 'Storage', 'Folder', 'Server'],
    welcome: 'Welcome', password: 'Password', signIn: 'Sign in',
    importTitle: 'Import a file', drop: 'Drop audio or video here', choose: 'choose a file',
    transcribing: 'Transcribing', summary: 'Summary ready', speakers: 'Awaiting speakers',
    detail: 'Speakers: waiting for you',
  },
  'pt-BR': {
    help: 'Ajuda', settings: 'Configurações', recent: 'Recentes',
    menu: ['Primeiros passos', 'Permissões de microfone', 'Pasta sincronizada',
      /Atalhos de teclado\s*Ctrl\+\//, /Abrir a central de ajuda\s*↗/,
      /Relatar um problema…\s*Anexe o eclume\.log/],
    shortcuts: 'Atalhos de teclado',
    global: ['Iniciar ou parar a gravação', 'Nova nota', 'Adicionar marcador'],
    window: ['Importar arquivo', 'Configurações', 'Atalhos de teclado'],
    tabs: ['Geral', 'Reuniões', 'Áudio', 'Armazenamento', 'Pasta', 'Servidor'],
    welcome: 'Bem-vindo', password: 'Senha', signIn: 'Entrar',
    importTitle: 'Importar um arquivo', drop: 'Solte o áudio ou o vídeo aqui', choose: 'escolha um arquivo',
    transcribing: 'Transcrevendo', summary: 'Resumo pronto', speakers: 'Aguardando locutores',
    detail: 'Locutores: aguardando você',
  },
}

async function expectHome(page: Page, locale: Locale) {
  const text = copy[locale]
  await expect(page.locator('[data-view="home"]')).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', locale)
  await expect(page.locator('#open-help')).toHaveAttribute('aria-label', text.help)
  await expect(page.locator('#open-settings')).toHaveAttribute('aria-label', text.settings)
  await expect(page.locator('#recent .kicker')).toHaveText(text.recent)
  await expect(page.locator('#recent-list [data-key="srv-t"] .badge')).toHaveText(text.transcribing)
  await expect(page.locator('#recent-list [data-key="srv-r"] .badge')).toHaveText(text.summary)
  await expect(page.locator('#recent-list [data-key="srv-l"] .badge')).toHaveText(text.speakers)
  await expect(page.locator('#recent-list [data-key="srv-l"] .recent-detail')).toContainText(text.detail)
}

for (const locale of ['en', 'pt-BR'] as const) {
  test.describe(locale, () => {
    test.use({ locale: locale === 'en' ? 'en-US' : 'pt-BR' })
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((value) => {
        ;(window as unknown as { __MOCK_LOCALE: string }).__MOCK_LOCALE = value
      }, locale)
    })

    test('renders home, help, shortcut actions, import and settings in the selected locale', async ({ open }) => {
      const page = await open('recent')
      const text = copy[locale]
      await expectHome(page, locale)
      await page.locator('#open-help').click()
      await expect(page.locator('#menu-help')).toBeVisible()
      await expect(page.locator('#menu-help [role="menuitem"]')).toHaveText(text.menu)
      await page.locator('#help-shortcuts').click()
      const sheet = page.locator('[data-view="shortcuts"]')
      await expect(sheet).toBeVisible()
      await expect(sheet.locator('h2')).toHaveText(text.shortcuts)
      await expect(sheet.locator('#shortcuts-global dt')).toHaveText(text.global)
      await expect(sheet.locator('#shortcuts-window dt')).toHaveText(text.window)
      await page.locator('#shortcuts-close').click()
      await page.locator('#import').click()
      const importView = page.locator('[data-view="import"]')
      await expect(importView).toBeVisible()
      await expect(importView.locator('h4')).toHaveText(text.importTitle)
      await expect(page.locator('#import-target strong')).toHaveText(text.drop)
      await expect(page.locator('#import-choose')).toHaveText(text.choose)
      await page.locator('#import-close').click()
      await page.locator('#open-settings').click()
      await expect(page.locator('[data-view="settings"]')).toBeVisible()
      await expect(page.getByRole('tab')).toHaveText(text.tabs)
    })

    test('renders first run in the selected locale', async ({ open }) => {
      const page = await open('firstRun')
      const text = copy[locale]
      const view = page.locator('[data-view="first-run"]')
      await expect(view).toBeVisible()
      await expect(view).toHaveAttribute('aria-label', text.welcome)
      await expect(page.locator('html')).toHaveAttribute('lang', locale)
      await expect(page.locator('label[for="first-run-password"]')).toHaveText(text.password)
      await expect(page.locator('#first-run-sign-in')).toHaveText(text.signIn)
    })

    test('reports the browser language tag exactly once at startup', async ({ open }) => {
      const page = await open()
      const tag = locale === 'en' ? 'en-US' : 'pt-BR'
      expect(await page.evaluate(() => navigator.language)).toBe(tag)
      const reports = async () => (await calls(page)).filter((call) => call.command === 'report_system_locale')
      await expect.poll(reports).toEqual([{ command: 'report_system_locale', args: { tag } }])
      await page.locator('#open-settings').click()
      await expect(page.getByRole('tab')).toHaveText(copy[locale].tabs)
      expect(await reports()).toEqual([{ command: 'report_system_locale', args: { tag } }])
    })
  })
}

test('status changes switch visible text in both directions without reloading', async ({ open }) => {
  const page = await open('recent')
  await expectHome(page, 'pt-BR')
  await page.evaluate(() => {
    Object.assign(document, { localeTestMarker: 'same document' })
  })
  for (const locale of ['en', 'pt-BR'] as const) {
    await page.evaluate((value) => {
      const mock = (window as unknown as { __mock: Mock }).__mock
      mock.state.status.locale = value
      mock.emit('status-changed')
    }, locale)
    await expectHome(page, locale)
    expect(await page.evaluate(() => (document as Document & { localeTestMarker?: string }).localeTestMarker))
      .toBe('same document')
    await page.locator('#open-help').click()
    await expect(page.locator('#menu-help [role="menuitem"]')).toHaveText(copy[locale].menu)
    await page.keyboard.press('Escape')
  }
})

test('catalogs have identical flattened keys and nonempty string values', async ({ open }) => {
  const page = await open()
  const catalogs = await page.evaluate(async () => {
    function flatten(value: Record<string, unknown>, prefix = ''): [string, unknown][] {
      return Object.entries(value).flatMap(([key, entry]) => {
        const name = prefix ? `${prefix}.${key}` : key
        return entry !== null && typeof entry === 'object'
          ? flatten(entry as Record<string, unknown>, name) : [[name, entry]]
      })
    }
    const paths = ['/js/locales/en.js', '/js/locales/pt-BR.js']
    return Promise.all(paths.map(async (path) => flatten((await import(path)).default).sort(([a], [b]) => a.localeCompare(b))))
  })
  expect(catalogs[0].length).toBeGreaterThan(0)
  expect(catalogs[0].map(([key]) => key)).toEqual(catalogs[1].map(([key]) => key))
  for (const [index, entries] of catalogs.entries()) {
    for (const [key, value] of entries) {
      expect(typeof value, `${index === 0 ? 'en' : 'pt-BR'}:${key}`).toBe('string')
      expect(String(value).trim(), key).not.toBe('')
    }
  }
})

test('a zero count reads as plural in both locales', async ({ open }) => {
  const page = await open()
  const texts = await page.evaluate(async () => {
    const i18n = await import('/js/i18n.js')
    return ['en', 'pt-BR'].map((locale) => {
      i18n.setLocale(locale)
      return [0, 1, 2].map((count) => [
        i18n.t('settings.storageUsed', { count, size: '0 B' }),
        i18n.t('settings.folder.recordings', { count }),
      ])
    })
  })
  expect(texts).toEqual([
    [
      ['0 recordings · 0 B on this computer', '0 recordings read'],
      ['1 recording · 0 B on this computer', '1 recording read'],
      ['2 recordings · 0 B on this computer', '2 recordings read'],
    ],
    [
      ['0 gravações · 0 B neste computador', '0 gravações lidas'],
      ['1 gravação · 0 B neste computador', '1 gravação lida'],
      ['2 gravações · 0 B neste computador', '2 gravações lidas'],
    ],
  ])
})

test.describe('fr-FR first, pt-BR second', () => {
  test.use({ locale: 'fr-FR' })
  test('the window reports the first supported system language', async ({ open, page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'languages', { get: () => ['fr-FR', 'pt-BR'] })
    })
    await open()
    const reports = async () => (await calls(page)).filter((call) => call.command === 'report_system_locale')
    await expect.poll(reports).toEqual([{ command: 'report_system_locale', args: { tag: 'pt-BR' } }])
  })
})
