import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { setLocale } from '../../i18n'
import { fixtures } from '../../test/fixtures'
import { empty, json, mockFetch } from '../../test/http'
import { preloadRoute, renderApp } from '../../test/render'
import { detectOs, parseInstallers, PLATFORMS } from './installers'

beforeAll(() => preloadRoute('/app-desktop'))

afterEach(async () => {
  vi.unstubAllGlobals()
  await setLocale('pt-BR')
  vi.restoreAllMocks()
})

const MANIFEST = {
  versao: '0.5.0',
  publicado_em: '2026-09-25T12:00:00Z',
  notas: '',
  instalacao: 'https://192.168.15.199:8443/downloads/0.5.0/INSTALACAO.md',
  instaladores: [
    {
      plataforma: 'windows',
      arquitetura: 'x86_64',
      tipo: 'nsis',
      arquivo: 'eclume_0.5.0_x64-setup.exe',
      url: 'https://192.168.15.199:8443/downloads/0.5.0/eclume_0.5.0_x64-setup.exe',
      tamanho: 9_437_184,
      sha256: 'a'.repeat(64),
      recomendado: true,
    },
    {
      plataforma: 'windows',
      arquitetura: 'x86_64',
      tipo: 'msi',
      arquivo: 'eclume_0.5.0_x64_pt-BR.msi',
      url: 'https://192.168.15.199:8443/downloads/0.5.0/eclume_0.5.0_x64_pt-BR.msi',
      tamanho: 10_485_760,
      sha256: 'b'.repeat(64),
      recomendado: false,
    },
    {
      plataforma: 'linux',
      arquitetura: 'x86_64',
      tipo: 'appimage',
      arquivo: 'eclume_0.5.0_amd64.AppImage',
      url: 'https://192.168.15.199:8443/downloads/0.5.0/eclume_0.5.0_amd64.AppImage',
      tamanho: 80_000_000,
      sha256: 'c'.repeat(64),
      recomendado: true,
    },
  ],
}

function mockDesktopApi(extra: Parameters<typeof mockFetch>[0] = {}) {
  return mockFetch({
    'GET /api/v1/me': () => fixtures.me(),
    'GET /downloads/instaladores.json': () => MANIFEST,
    'GET /api/v1/tokens': () => fixtures.tokenPage(),
    ...extra,
  })
}

function cards() {
  return within(screen.getByRole('list', { name: 'Sistemas' })).getAllByRole('listitem')
}

describe('desktop app', () => {
  it('reads in English when the account chose English', async () => {
    const me = fixtures.me()
    mockDesktopApi({ 'GET /api/v1/me': () => ({ ...me, user: { ...me.user, locale: 'en' } }) })
    renderApp('/app-desktop')
    expect(await screen.findByRole('heading', { level: 1, name: 'Desktop app' })).toBeInTheDocument()
    const systems = screen.getByRole('list', { name: 'Systems' })
    expect(within(systems).getByText('Windows 10 or 11 · 64-bit')).toBeInTheDocument()
    expect(await within(systems).findByRole('link', { name: 'Download for Windows' })).toBeInTheDocument()
    expect(within(systems).getByRole('link', { name: /\.msi package/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Generate a link code' })).toBeInTheDocument()
  })

  it('puts the system of this computer first, with the recommended installer and the other types', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
    mockDesktopApi()
    renderApp('/app-desktop')
    expect(await screen.findByRole('heading', { name: 'App desktop' })).toBeInTheDocument()
    const windows = (await screen.findAllByRole('listitem', { name: 'Windows' }))[0]
    expect(cards()[0]).toBe(windows)
    expect(await within(windows).findByText('eclume_0.5.0_x64-setup.exe')).toBeInTheDocument()
    expect(within(windows).getByRole('link', { name: 'Baixar para Windows' })).toHaveAttribute(
      'href',
      MANIFEST.instaladores[0].url,
    )
    expect(within(windows).getByRole('link', { name: /Pacote \.msi/ })).toHaveAttribute('href', MANIFEST.instaladores[1].url)
    expect(within(windows).getByText('Primeira vez?')).toBeInTheDocument()
    expect(within(windows).getByText(/Executar assim mesmo/)).toBeInTheDocument()

    const mac = cards().find((card) => card.getAttribute('aria-labelledby') === 'os-macos')!
    expect(within(mac).getByText('Os instaladores ainda não foram publicados neste servidor.')).toBeInTheDocument()
  })

  it('with no published installers, each card warns', async () => {
    mockDesktopApi({ 'GET /downloads/instaladores.json': () => empty(404) })
    renderApp('/app-desktop')
    expect(await screen.findAllByText('Os instaladores ainda não foram publicados neste servidor.')).toHaveLength(3)
    expect(screen.queryByRole('link', { name: /Baixar/ })).not.toBeInTheDocument()
  })

  it('generates the pairing code by button and lists only the computers', async () => {
    const http = mockDesktopApi({
      'POST /api/v1/devices/pairing-codes': () =>
        json(fixtures.pairingCodeCreated(), 201, { Date: 'Sun, 27 Sep 2026 14:02:18 GMT' }),
      'GET /api/v1/devices/pairing-codes/:id': () => ({
        ...fixtures.pairingCodeUsed(),
        status: 'pending',
        token_id: null,
      }),
    })
    renderApp('/app-desktop')
    const devices = await screen.findByRole('region', { name: 'Computadores vinculados' })
    expect(await within(devices).findByText('Desktop — notebook da Mariana')).toBeInTheDocument()
    expect(within(devices).queryByText('lumea — importador')).not.toBeInTheDocument()

    expect(http.requests('POST /api/v1/devices/pairing-codes')).toHaveLength(0)
    await userEvent.click(screen.getByRole('button', { name: 'Gerar código de vínculo' }))
    expect(await screen.findByText('K7Q-4MX')).toBeInTheDocument()
    expect(screen.getByText(/Vale por 9:4\d/)).toBeInTheDocument()
    expect(http.requests('POST /api/v1/devices/pairing-codes')).toHaveLength(1)
  })
})

describe('installers', () => {
  it('validates the manifest and rejects what lacks the standard shape', () => {
    expect(parseInstallers(MANIFEST)?.instaladores).toHaveLength(3)
    expect(parseInstallers({ versao: '0.5.0' })).toBeNull()
    expect(parseInstallers({ versao: '0.5.0', instaladores: [{ plataforma: 'android' }] })).toBeNull()
    expect(parseInstallers('oi')).toBeNull()
  })

  it('detects the system from the user agent', () => {
    expect(detectOs('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)')).toBe('macos')
    expect(detectOs('Mozilla/5.0 (X11; Linux x86_64)')).toBe('linux')
    expect(detectOs('Mozilla/5.0 (Linux; Android 14)')).toBeNull()
    expect(detectOs('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBeNull()
  })

  it('covers macOS, Windows and Linux, in DS order', () => {
    expect(PLATFORMS.map((p) => p.os)).toEqual(['macos', 'windows', 'linux'])
  })
})
