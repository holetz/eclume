import { render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppProviders } from '../app/providers'
import { createQueryClient } from '../app/queryClient'
import { useMe } from '../app/session'
import { fixtures } from '../test/fixtures'
import { mockFetch, problem } from '../test/http'
import { i18n } from './index'

/** A screen that reads the session, as the guarded routes and the login do. */
function SessionReader() {
  useMe()
  return null
}

function renderSync(readsSession = true) {
  return render(
    <AppProviders client={createQueryClient({ retry: false })}>{readsSession && <SessionReader />}</AppProviders>,
  )
}

function withBrowserLanguages(languages: string[]) {
  Object.defineProperty(navigator, 'languages', { configurable: true, get: () => languages })
}

afterEach(() => {
  withBrowserLanguages(['pt-BR'])
  vi.unstubAllGlobals()
})

describe('LocaleSync', () => {
  it('applies the account locale once /me answers', async () => {
    const me = fixtures.me()
    me.user.locale = 'en'
    mockFetch({ 'GET /api/v1/me': () => me })
    renderSync()
    await waitFor(() => expect(i18n.language).toBe('en'))
    expect(document.documentElement.lang).toBe('en')
  })

  it('falls back to the browser language when the account never chose one', async () => {
    withBrowserLanguages(['en-GB', 'pt-BR'])
    const me = fixtures.me()
    me.user.locale = null
    mockFetch({ 'GET /api/v1/me': () => me })
    renderSync()
    await waitFor(() => expect(i18n.language).toBe('en'))
  })

  it('uses the browser language without a session', async () => {
    withBrowserLanguages(['fr-FR', 'en-US'])
    mockFetch({ 'GET /api/v1/me': () => problem('unauthorized', 401) })
    renderSync()
    await waitFor(() => expect(i18n.language).toBe('en'))
    expect(document.documentElement.lang).toBe('en')
  })

  it('never calls /me on its own', async () => {
    const calls = mockFetch({})
    renderSync(false)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(calls.fetch).not.toHaveBeenCalled()
    expect(i18n.language).toBe('pt-BR')
  })
})
