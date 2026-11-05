// @vitest-environment node
// The phone's UI text lives in the catalogs (ui/src/i18n): this check fails on Portuguese text left in
// the code. It reads every .ts/.tsx under ui/src, drops the comments, and looks for Portuguese
// letters or words. The pt-BR catalog, the vocabulary copy of the web, the tests and the tests' fake
// bridge are skipped. Typed by tsconfig.node.json (reads files from disk).
import { type Dirent, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const SKIPPED = new Set(['i18n/pt-BR.ts', 'app/vocabulario.js', 'app/vocabulario.d.ts', 'bridge/fake.ts', 'test-setup.ts'])

const PORTUGUESE_LETTERS = /[çãõáéíóúâêôàÇÃÕÁÉÍÓÚÂÊÔÀ]/
const PORTUGUESE_WORDS =
  /\b(Gravar|Gravando|Sincroniza\w*|Configura\w*|Entrar|Cancelar|Salvar|Excluir|Parar|Pausar|Pausado|Continuar|Marcador\w*|Nenhum\w*|Servidor|Aguardando|Abrir|Sair|Voltar|Hoje|Ontem|cerca de|menos de)\b/

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry: Dirent) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })
}

/** The code without its comments (line, block and JSX comments), keeping line numbers. */
function withoutComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

describe('literal strings', () => {
  const files = sources(ROOT)
    .map((path) => relative(ROOT, path).replaceAll('\\', '/'))
    .filter((path) => !SKIPPED.has(path))

  it('reads the UI sources', () => {
    expect(files).toContain('screens/Home.tsx')
    expect(files).toContain('i18n/en.ts')
  })

  it('has no Portuguese text outside the pt-BR catalog', () => {
    const hits: string[] = []
    for (const file of files) {
      withoutComments(readFileSync(join(ROOT, file), 'utf8'))
        .split('\n')
        .forEach((line, index) => {
          if (PORTUGUESE_LETTERS.test(line) || PORTUGUESE_WORDS.test(line)) hits.push(`${file}:${index + 1}: ${line.trim()}`)
        })
    }
    expect(hits).toEqual([])
  })
})
