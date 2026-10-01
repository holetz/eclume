// @vitest-environment node
// Todo código de motivo (`reason`) que o servidor grava numa etapa pulada tem texto no vocabulário.
// Os códigos são lidos do código do servidor e das migrations: literais em `detail={"reason": ...}`,
// `skip = "..."`, `reason="..."` e constantes (`CANCELLED`) resolvidas no mesmo pacote.
// Tipado pelo tsconfig.node.json (lê arquivos do disco).
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ETAPAS, MOTIVOS, motivo, nomeDaEtapa } from './vocabulario.js'

const SERVER = new URL('../../../server/src/eclume_server/', import.meta.url)
const MIGRATIONS = new URL('db/migrations/', SERVER)

function read(dir: URL, ext: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(ext))
    .map((name) => readFileSync(new URL(name, dir), 'utf8'))
}

function serverReasons(): Set<string> {
  const python = read(SERVER, '.py')
  const constants = new Map<string, string>()
  for (const source of python) {
    for (const [, name, value] of source.matchAll(/^([A-Z_]+)\s*=\s*"(\w+)"/gm)) constants.set(name, value)
  }
  const codes = new Set<string>()
  for (const source of [...python, ...read(MIGRATIONS, '.sql')]) {
    for (const [, literal, constant] of source.matchAll(/"reason":\s*(?:"(\w+)"|([A-Z_]+))/g)) {
      const code = literal ?? constants.get(constant)
      if (code) codes.add(code)
    }
    for (const [, code] of source.matchAll(/\b(?:skip\s*=|reason=)\s*"(\w+)"/g)) codes.add(code)
  }
  return codes
}

describe('vocabulário', () => {
  it('tem texto para cada código de motivo do servidor', () => {
    const codes = serverReasons()
    expect(codes.size).toBeGreaterThan(5)
    expect([...codes].filter((code) => !(code in MOTIVOS))).toEqual([])
  })

  it('segue a ordem das etapas do servidor', () => {
    const pipeline = readFileSync(new URL('pipeline.py', SERVER), 'utf8')
    const steps = pipeline.match(/^STEPS\s*=\s*\(([^)]*)\)/m)?.[1] ?? ''
    expect(ETAPAS.map((item) => item.etapa)).toEqual([...steps.matchAll(/"(\w+)"/g)].map((m) => m[1]))
  })

  it('mostra cru o que ainda não tem texto', () => {
    expect(motivo('codigo_novo')).toBe('codigo_novo')
    expect(nomeDaEtapa('etapa_nova')).toBe('etapa_nova')
    expect(motivo('no_provider')).toMatch(/fale com quem administra/)
  })
})
