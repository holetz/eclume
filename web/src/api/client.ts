// Cliente da API v1, tipado pelo contrato (schema.gen.ts, gerado por `npm run gen:api`).
// Origem única: o app chama /api/v1 relativo à própria origem, com o cookie de sessão.
import createClient, { type Middleware } from 'openapi-fetch'
import type { components, paths } from './schema.gen'

export type Schemas = components['schemas']

export const CSRF_COOKIE = 'eclume_csrf'
// O painel admin tem sessão própria, com o próprio cookie de CSRF.
export const ADMIN_CSRF_COOKIE = 'eclume_admin_csrf'
export const CSRF_HEADER = 'X-CSRF-Token'
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const LOGIN_PATH = '/api/v1/auth/login'
const ADMIN_PREFIX = '/api/v1/admin/'
const ADMIN_LOGIN_PATH = '/api/v1/admin/auth/login'

/** A requisição é do painel admin (sessão de admin), e não da sessão do usuário. */
export function isAdminUrl(url: string): boolean {
  return new URL(url, 'http://localhost').pathname.startsWith(ADMIN_PREFIX)
}

export function readCookie(name: string, cookies: string = globalThis.document?.cookie ?? ''): string | null {
  for (const pair of cookies.split(';')) {
    const [key, ...rest] = pair.trim().split('=')
    if (key === name) return decodeURIComponent(rest.join('='))
  }
  return null
}

/**
 * Double-submit: todo método mutável ecoa no header `X-CSRF-Token` o cookie da sessão da área:
 * `eclume_admin_csrf` em /api/v1/admin/, `eclume_csrf` no resto.
 */
export const csrfMiddleware: Middleware = {
  onRequest({ request }) {
    if (!SAFE_METHODS.has(request.method)) {
      const token = readCookie(isAdminUrl(request.url) ? ADMIN_CSRF_COOKIE : CSRF_COOKIE)
      if (token) request.headers.set(CSRF_HEADER, token)
    }
    return request
  },
}

const unauthorizedListeners = new Set<() => void>()
const adminUnauthorizedListeners = new Set<() => void>()

function subscribe(listeners: Set<() => void>, listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Avisa quando a API responde 401 à sessão do usuário (ausente ou expirada), fora do próprio login. */
export function onUnauthorized(listener: () => void): () => void {
  return subscribe(unauthorizedListeners, listener)
}

/** Avisa quando o painel admin recebe 401 (sessão de admin ausente ou expirada), fora do login do admin. */
export function onAdminUnauthorized(listener: () => void): () => void {
  return subscribe(adminUnauthorizedListeners, listener)
}

export const unauthorizedMiddleware: Middleware = {
  onResponse({ response, schemaPath }) {
    if (response.status !== 401) return response
    // Um 401 do painel admin é da sessão de admin, e só a guarda do painel o ouve.
    const admin = schemaPath.startsWith(ADMIN_PREFIX)
    const login = admin ? ADMIN_LOGIN_PATH : LOGIN_PATH
    if (schemaPath !== login) {
      for (const listener of admin ? adminUnauthorizedListeners : unauthorizedListeners) listener()
    }
    return response
  },
}

// Fora do navegador (testes em ambiente node) não há origem; a base só precisa ser absoluta.
const ORIGIN = typeof window === 'undefined' ? 'http://localhost' : window.location.origin

export function createApiClient(baseUrl: string = ORIGIN) {
  const client = createClient<paths>({
    baseUrl,
    credentials: 'same-origin',
    // Resolve o fetch a cada chamada, para os testes poderem substituí-lo.
    fetch: (request) => globalThis.fetch(request),
  })
  client.use(csrfMiddleware, unauthorizedMiddleware)
  return client
}

export type ApiClient = ReturnType<typeof createApiClient>

export const api = createApiClient()
