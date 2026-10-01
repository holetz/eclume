// @vitest-environment node
// O vocabulário de estados do celular é cópia fiel do web (web/src/lib/vocabulario.js), como o
// ui_assets do desktop confere a dele. Tipado pelo tsconfig.node.json (lê arquivo do disco).
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const ler = (url: URL) => readFileSync(url, 'utf8').replace(/\r\n/g, '\n')

describe('cópia do vocabulário', () => {
  for (const nome of ['vocabulario.js', 'vocabulario.d.ts']) {
    const web = new URL(`../../../../web/src/lib/${nome}`, import.meta.url)
    it.skipIf(!existsSync(web))(`${nome} é igual ao do web`, () => {
      expect(ler(new URL(`./${nome}`, import.meta.url)) === ler(web)).toBe(true)
    })
  }
})
