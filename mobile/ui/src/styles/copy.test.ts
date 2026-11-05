// @vitest-environment node
// The phone's copy of the DS is faithful to the web's, as the desktop's ui_assets checks its own:
// product adjustments go in app.css, never in eclume.css. Typed by tsconfig.node.json (reads a file
// from disk).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (relative: string) =>
  readFileSync(new URL(relative, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

describe('Design System copy', () => {
  it('the phone eclume.css equals the web one', () => {
    const mobile = read('./eclume.css')
    expect(mobile.length).toBeGreaterThan(10_000)
    expect(mobile === read('../../../../web/src/styles/eclume.css')).toBe(true)
  })
})
