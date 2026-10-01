// Fronteiras entre as features do web, como um teste da suíte: o grafo de imports entre
// `src/features/*` não tem ciclo, só o próprio admin e as rotas importam `features/admin/`, e
// `src/shared/` não importa de `features/` nem de `app/`.
import { describe, expect, it } from 'vitest'

const sources = import.meta.glob<string>('/src/**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true })

const IMPORT = /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g

/** `/src/features/x/y.tsx` + `../z/w` → `/src/features/z/w`. */
function resolve(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const parts = from.split('/').slice(0, -1)
  for (const piece of spec.split('/')) {
    if (piece === '..') parts.pop()
    else if (piece !== '.') parts.push(piece)
  }
  return parts.join('/')
}

const featureOf = (path: string) => /^\/src\/features\/([^/]+)\//.exec(path)?.[1] ?? null

/** Os imports de código de produção (sem testes), já resolvidos. */
function edges(): { from: string; to: string }[] {
  const list: { from: string; to: string }[] = []
  for (const [file, text] of Object.entries(sources)) {
    if (/\.test\.tsx?$/.test(file) || file.startsWith('/src/test/')) continue
    for (const match of text.matchAll(IMPORT)) {
      const to = resolve(file, match[1] ?? match[2])
      if (to) list.push({ from: file, to })
    }
  }
  return list
}

function findCycle(graph: Map<string, Set<string>>): string[] | null {
  const state = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []
  function visit(node: string): string[] | null {
    state.set(node, 'visiting')
    stack.push(node)
    for (const next of graph.get(node) ?? []) {
      if (state.get(next) === 'visiting') return [...stack.slice(stack.indexOf(next)), next]
      if (!state.has(next)) {
        const cycle = visit(next)
        if (cycle) return cycle
      }
    }
    stack.pop()
    state.set(node, 'done')
    return null
  }
  for (const node of graph.keys()) {
    if (state.has(node)) continue
    const cycle = visit(node)
    if (cycle) return cycle
  }
  return null
}

describe('fronteiras entre features', () => {
  it('lê o código do app', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(100)
  })

  it('o grafo de imports entre features não tem ciclo', () => {
    const graph = new Map<string, Set<string>>()
    for (const { from, to } of edges()) {
      const a = featureOf(from)
      const b = featureOf(to)
      if (!a || !b || a === b) continue
      graph.set(a, (graph.get(a) ?? new Set()).add(b))
    }
    // O grafo foi montado de fato (a gravação usa pessoas, a busca usa a gravação…).
    expect(graph.get('transcript')?.has('people')).toBe(true)
    expect(findCycle(graph)).toBeNull()
  })

  it('só o próprio admin e as rotas importam features/admin/', () => {
    const outside = edges().filter(
      ({ from, to }) =>
        featureOf(to) === 'admin' && featureOf(from) !== 'admin' && from !== '/src/app/routes.tsx',
    )
    expect(outside.map(({ from, to }) => `${from} → ${to}`)).toEqual([])
  })

  it('src/shared/ não importa de features/ nem de app/', () => {
    const leaks = edges().filter(
      ({ from, to }) => from.startsWith('/src/shared/') && /^\/src\/(features|app)\//.test(to),
    )
    expect(leaks.map(({ from, to }) => `${from} → ${to}`)).toEqual([])
  })
})
