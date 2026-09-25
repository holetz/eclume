// Dublê de fetch para os testes: rotas "MÉTODO /caminho/:param" respondem com fixtures do contrato.
import { vi } from 'vitest'

type Params = Record<string, string>
type Handler = (request: Request, params: Params) => Response | unknown | Promise<Response | unknown>

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

export function empty(status = 204, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers })
}

export function problem(code: string, status: number, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ type: 'about:blank', title: code, status, code, ...extra }), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  })
}

function match(pattern: string, path: string): Params | null {
  const want = pattern.split('/')
  const got = path.split('/')
  if (want.length !== got.length) return null
  const params: Params = {}
  for (let i = 0; i < want.length; i++) {
    if (want[i].startsWith(':')) params[want[i].slice(1)] = decodeURIComponent(got[i])
    else if (want[i] !== got[i]) return null
  }
  return params
}

/**
 * Instala um fetch que despacha pelas rotas dadas. Um handler que devolve um objeto qualquer
 * vira JSON 200; rota não simulada lança, para o teste falhar alto.
 */
export function mockFetch(routes: Record<string, Handler>) {
  const calls: Request[] = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request && !init ? input : new Request(input, init)
    calls.push(request.clone())
    const url = new URL(request.url)
    for (const [key, handler] of Object.entries(routes)) {
      const [method, pattern] = key.split(' ')
      const params = method === request.method ? match(pattern, url.pathname) : null
      if (params) {
        const result = await handler(request, params)
        return result instanceof Response ? result : json(result)
      }
    }
    throw new Error(`rota não simulada: ${request.method} ${url.pathname}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return {
    calls,
    fetch: fetchMock,
    /** Requisições feitas a uma rota ("MÉTODO /caminho/:param"). */
    requests(key: string): Request[] {
      const [method, pattern] = key.split(' ')
      return calls.filter((r) => r.method === method && match(pattern, new URL(r.url).pathname))
    },
  }
}
