// @vitest-environment node
// A cópia do DS do celular é fiel à do web, como o ui_assets do desktop confere a dele: ajuste de
// produto vai no app.css, nunca no eclume.css. Tipado pelo tsconfig.node.json (lê arquivo do disco).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const ler = (relativo: string) =>
  readFileSync(new URL(relativo, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

describe('cópia do Design System', () => {
  it('o eclume.css do celular é igual ao do web', () => {
    const movel = ler('./eclume.css')
    expect(movel.length).toBeGreaterThan(10_000)
    expect(movel === ler('../../../../web/src/styles/eclume.css')).toBe(true)
  })
})
