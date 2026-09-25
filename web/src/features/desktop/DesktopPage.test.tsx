import { screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fixtures } from '../../test/fixtures'
import { mockFetch } from '../../test/http'
import { renderApp } from '../../test/render'
import { detectOs, PLATFORMS } from './links'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('app desktop', () => {
  it('põe o sistema deste computador primeiro e avisa do instalador sem assinatura', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
    mockFetch({ 'GET /api/v1/me': () => fixtures.me() })
    renderApp('/app-desktop')
    const cards = within(await screen.findByRole('list', { name: 'Sistemas' })).getAllByRole('listitem', { name: /./ })
    expect(cards[0]).toHaveAccessibleName('Windows')
    expect(within(cards[0]).getByText('Este computador')).toBeInTheDocument()
    expect(within(cards[0]).getByText(/Executar assim mesmo/)).toBeInTheDocument()
    expect(within(cards[0]).getAllByText(/ainda não publicado/)).toHaveLength(2)
    expect(screen.getByRole('link', { name: 'token de acesso' })).toHaveAttribute('href', '/tokens')
  })

  it('detecta o sistema pelo user agent', () => {
    expect(detectOs('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)')).toBe('macos')
    expect(detectOs('Mozilla/5.0 (X11; Linux x86_64)')).toBe('linux')
    expect(detectOs('Mozilla/5.0 (Linux; Android 14)')).toBeNull()
    expect(detectOs('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBeNull()
  })

  it('cobre Windows, macOS e Linux', () => {
    expect(PLATFORMS.map((p) => p.os)).toEqual(['windows', 'macos', 'linux'])
  })
})
