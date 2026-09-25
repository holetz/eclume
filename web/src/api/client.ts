// Cliente da API v1, tipado pelo contrato (schema.gen.ts, gerado por `npm run gen:api`).
// Origem única: o app chama /api/v1 relativo à própria origem, com o cookie de sessão.
import createClient, { type Middleware } from 'openapi-fetch'
import type { components, paths } from './schema.gen'

export type Schemas = components['schemas']

export const CSRF_COOKIE = 'eclume_csrf'
export const CSRF_HEADER = 'X-CSRF-Token'
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const LOGIN_PATH = '/api/v1/auth/login'

export function readCookie(name: string, cookies: string = globalThis.document?.cookie ?? ''): string | null {
  for (const pair of cookies.split(';')) {
    const [key, ...rest] = pair.trim().split('=')
    if (key === name) return decodeURIComponent(rest.join('='))
  }
  return null
}

/** Double-submit: todo método mutável ecoa o cookie `eclume_csrf` no header `X-CSRF-Token`. */
export const csrfMiddleware: Middleware = {
  onRequest({ request }) {
    if (!SAFE_METHODS.has(request.method)) {
      const token = readCookie(CSRF_COOKIE)
      if (token) request.headers.set(CSRF_HEADER, token)
    }
    return request
  },
}

const unauthorizedListeners = new Set<() => void>()

/** Avisa quando a API responde 401 (sessão ausente ou expirada), fora do próprio login. */
export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener)
  return () => unauthorizedListeners.delete(listener)
}

export const unauthorizedMiddleware: Middleware = {
  onResponse({ response, schemaPath }) {
    if (response.status === 401 && schemaPath !== LOGIN_PATH) {
      for (const listener of unauthorizedListeners) listener()
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
