// Every `ProblemCode` of the contract has its own message in every locale, and the UI never shows the
// problem's English `title` or `detail`.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { i18n, resources, setLocale } from '../i18n'
import { ApiError, errorMessage } from './problem'

/** The `ProblemCode` enum, read from the source contract (vitest runs from `web/`). */
function contractCodes(): string[] {
  const contract = readFileSync(join(process.cwd(), '..', 'contracts', 'openapi-v1.yaml'), 'utf8')
  const lines = contract.split('\n')
  const start = lines.findIndex((line) => line === '    ProblemCode:')
  const enumAt = lines.findIndex((line, index) => index > start && line.trim() === 'enum:')
  const codes: string[] = []
  for (const line of lines.slice(enumAt + 1)) {
    const item = /^\s+- ([a-z_0-9]+)$/.exec(line)
    if (!item) break
    codes.push(item[1])
  }
  return codes
}

const problemOf = (code: string, status = 400) =>
  new ApiError(status, { type: 'about:blank', title: 'English title', status, code, detail: 'English detail.' })

afterEach(() => setLocale('pt-BR'))

describe('problem codes', () => {
  const codes = contractCodes()

  it('reads the whole enum from the contract', () => {
    expect(codes.length).toBeGreaterThan(30)
    expect(codes).toContain('unauthorized')
    expect(codes).toContain('error')
  })

  it.each(Object.keys(resources))('has a message for every code in %s', async (locale) => {
    await setLocale(locale as keyof typeof resources)
    const catalog = i18n.getResourceBundle(locale, 'errors').code as Record<string, string>
    expect(Object.keys(catalog).sort()).toEqual([...codes].sort())
    for (const code of codes) {
      if (code === 'validation_failed' || code === 'quota_exceeded') continue
      const message = errorMessage(problemOf(code))
      expect(message, code).toBe(catalog[code])
      expect(message).not.toMatch(/English/)
    }
  })

  it('follows the active locale', async () => {
    expect(errorMessage(problemOf('not_found', 404))).toBe('Não encontrado. Pode ter sido excluído.')
    await setLocale('en')
    expect(errorMessage(problemOf('not_found', 404))).toBe('Not found. It may have been deleted.')
    expect(errorMessage(new TypeError('Failed to fetch'))).toMatch(/No connection/)
  })

  it('reads an unknown code by its HTTP status, never by its detail', async () => {
    await setLocale('en')
    expect(errorMessage(problemOf('brand_new', 404))).toBe('Not found. It may have been deleted.')
    expect(errorMessage(problemOf('brand_new', 503))).toMatch(/did not answer/)
    expect(errorMessage(problemOf('brand_new', 418))).toBe('The server answered with an error (HTTP 418).')
  })

  it('formats quota sizes in the active locale', async () => {
    const quota = new ApiError(403, {
      type: 'about:blank',
      title: 't',
      status: 403,
      code: 'quota_exceeded',
      quota: 'file_bytes',
      limit: 1.5 * 1024 ** 3,
    })
    expect(errorMessage(quota)).toMatch(/\(1,5 GB\)/)
    await setLocale('en')
    expect(errorMessage(quota)).toMatch(/\(1\.5 GB\)/)
  })
})
