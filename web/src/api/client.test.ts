import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { empty, json, mockFetch, problem } from '../test/http'
import { CSRF_HEADER, createApiClient, isAdminUrl, onAdminUnauthorized, onUnauthorized, readCookie } from './client'
import { ApiError, errorMessage, type Problem, unwrap } from './problem'

const me = { user: { id: 'u' } }

function clearCookies() {
  for (const c of document.cookie.split(';')) {
    const name = c.split('=')[0].trim()
    if (name) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`
  }
}

describe('API client', () => {
  beforeEach(() => {
    clearCookies()
    document.cookie = 'eclume_csrf=tok%2B1; path=/'
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    clearCookies()
  })

  it('reads cookies by name, decoding the value', () => {
    expect(readCookie('eclume_csrf')).toBe('tok+1')
    expect(readCookie('ausente')).toBeNull()
    expect(readCookie('b', 'a=1; b=x=y')).toBe('x=y')
  })

  it('echoes the CSRF only on a mutating method', async () => {
    const http = mockFetch({
      'GET /api/v1/me': () => me,
      'DELETE /api/v1/tokens/:id': () => empty(),
    })
    const api = createApiClient()
    await api.GET('/api/v1/me')
    await api.DELETE('/api/v1/tokens/{token_id}', { params: { path: { token_id: 't1' } } })
    expect(http.requests('GET /api/v1/me')[0].headers.get(CSRF_HEADER)).toBeNull()
    expect(http.requests('DELETE /api/v1/tokens/:id')[0].headers.get(CSRF_HEADER)).toBe('tok+1')
    expect(http.calls[0].credentials).toBe('same-origin')
  })

  it('echoes the admin session CSRF in the admin panel', async () => {
    document.cookie = 'eclume_admin_csrf=adm; path=/'
    const http = mockFetch({
      'PATCH /api/v1/admin/settings': () => ({}),
      'POST /api/v1/admin/auth/logout': () => empty(),
    })
    const api = createApiClient()
    await api.PATCH('/api/v1/admin/settings', { body: { asr: { model: 'large-v3' } } })
    await api.POST('/api/v1/admin/auth/logout')
    expect(http.requests('PATCH /api/v1/admin/settings')[0].headers.get(CSRF_HEADER)).toBe('adm')
    expect(http.requests('POST /api/v1/admin/auth/logout')[0].headers.get(CSRF_HEADER)).toBe('adm')
    expect(isAdminUrl('http://x/api/v1/admin/me')).toBe(true)
    expect(isAdminUrl('http://x/api/v1/me')).toBe(false)
  })

  it('a 401 from the admin panel does not drop the user session', async () => {
    mockFetch({ 'GET /api/v1/admin/me': () => problem('unauthorized', 401) })
    const listener = vi.fn()
    const off = onUnauthorized(listener)
    await createApiClient().GET('/api/v1/admin/me')
    expect(listener).not.toHaveBeenCalled()
    off()
  })

  it('a 401 from the panel notifies only the admin guard, outside the admin login', async () => {
    mockFetch({
      'GET /api/v1/admin/users': () => problem('unauthorized', 401),
      'POST /api/v1/admin/auth/login': () => problem('unauthorized', 401),
    })
    const listener = vi.fn()
    const off = onAdminUnauthorized(listener)
    const api = createApiClient()
    await api.POST('/api/v1/admin/auth/login', { body: { email: 'a@b.c', password: 'x' } })
    expect(listener).not.toHaveBeenCalled()
    await api.GET('/api/v1/admin/users')
    expect(listener).toHaveBeenCalledTimes(1)
    off()
  })

  it('notifies the 401 outside the login', async () => {
    mockFetch({
      'GET /api/v1/me': () => problem('unauthorized', 401),
      'POST /api/v1/auth/login': () => problem('unauthorized', 401),
    })
    const listener = vi.fn()
    const off = onUnauthorized(listener)
    const api = createApiClient()
    await api.POST('/api/v1/auth/login', { body: { email: 'a@b.c', password: 'x' } })
    expect(listener).not.toHaveBeenCalled()
    await api.GET('/api/v1/me')
    expect(listener).toHaveBeenCalledTimes(1)
    off()
  })

  it('unwrap returns the data or throws ApiError with the code', async () => {
    mockFetch({
      'GET /api/v1/me': () => json(me),
      'GET /api/v1/recordings/:id': () => problem('not_found', 404),
    })
    const api = createApiClient()
    await expect(unwrap(api.GET('/api/v1/me'))).resolves.toEqual(me)
    const error = await unwrap(
      api.GET('/api/v1/recordings/{recording_id}', { params: { path: { recording_id: 'r' } } }),
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).code).toBe('not_found')
    expect((error as ApiError).status).toBe(404)
  })
})

describe('errorMessage', () => {
  it('translates by code, details validation and reads an unknown code by its status', () => {
    expect(errorMessage(new ApiError(403, { type: 'x', title: 't', status: 403, code: 'forbidden' }))).toMatch(
      /permissão/,
    )
    const validation = new ApiError(422, {
      type: 'x',
      title: 't',
      status: 422,
      code: 'validation_failed',
      errors: [{ field: 'name', message: 'obrigatório' }],
    })
    expect(errorMessage(validation)).toBe('Confira os campos — name: obrigatório.')
    expect(
      errorMessage(new ApiError(500, { type: 'x', title: 't', status: 500, code: 'novo', detail: 'Failed.' })),
    ).toBe('O servidor não respondeu. Tente de novo em instantes.')
    expect(errorMessage(new ApiError(502, null))).toMatch(/HTTP 502/)
    expect(errorMessage(new TypeError('Failed to fetch'))).toMatch(/Sem conexão/)
  })

  it('explains the exceeded quota by the quota and the limit', () => {
    const quota = (name: NonNullable<Problem['quota']>, limit: number) =>
      errorMessage(
        new ApiError(403, { type: 'x', title: 't', status: 403, code: 'quota_exceeded', quota: name, limit }),
      )
    expect(quota('file_bytes', 2 * 1024 ** 3)).toBe('O arquivo passa do tamanho máximo da sua conta (2 GB).')
    expect(quota('storage_bytes', 10 * 1024 ** 3)).toMatch(/limite de 10 GB/)
    expect(quota('open_uploads', 3)).toMatch(/até 3 arquivos ao mesmo tempo/)
    expect(quota('agent_requests_24h', 200)).toMatch(/200 pedidos ao agente em 24 horas/)
  })
})
