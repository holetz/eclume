// @vitest-environment node
// Contraste dos tokens do eclume.css (WCAG): borda de controle ≥ 3:1 (1.4.11, que o axe não mede) e
// texto ≥ 4,5:1 (1.4.3), no tema claro e no escuro, sobre o fundo e a superfície. Os valores são
// lidos do próprio CSS, com `var()` e `color-mix(... transparent)` resolvidos sobre o fundo.
// Tipado pelo tsconfig.node.json (lê o arquivo do disco).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./eclume.css', import.meta.url), 'utf8')

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`bloco ausente: ${selector}`)
  const body = css.slice(start, css.indexOf('}', start))
  return Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]))
}

const LIGHT = block(':root')
const DARK = { ...LIGHT, ...block(":root[data-theme='dark']") }

type Rgb = [number, number, number]

function hex(value: string): Rgb {
  const h = value.replace('#', '')
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb
}

/** Resolve um valor de cor do tema para RGB, compondo `color-mix(... transparent)` sobre `under`. */
function resolve(value: string, theme: Record<string, string>, under: Rgb): Rgb {
  const v = value.trim()
  const ref = /^var\((--[\w-]+)\)$/.exec(v)
  if (ref) return resolve(theme[ref[1]], theme, under)
  const mix = /^color-mix\(in srgb,\s*(.+?)\s+(\d+(?:\.\d+)?)%,\s*transparent\)$/.exec(v)
  if (mix) {
    const fg = resolve(mix[1], theme, under)
    const p = Number(mix[2]) / 100
    return fg.map((c, i) => Math.round(c * p + under[i] * (1 - p))) as Rgb
  }
  if (/^#[0-9a-f]{6}$/i.test(v)) return hex(v)
  throw new Error(`cor não resolvida: ${v}`)
}

function luminance([r, g, b]: Rgb): number {
  const f = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

function ratio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** A cor do `color` (ou da borda) de uma regra do DS, para o par que ela desenha. */
function ruleColor(selector: string, property: string): string {
  // Cada regra do CSS é `seletor { corpo }`; o seletor é a última linha antes do `{`.
  const rule = css
    .split('}')
    .map((chunk) => chunk.split('{'))
    .find(([head]) => head.trim().split(/\n/).pop()?.trim() === selector)
  if (!rule) throw new Error(`regra ausente: ${selector}`)
  const body = rule[1]
  const declaration = body
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${property}:`) || part.startsWith(`${property} :`))
  if (!declaration) throw new Error(`${property} ausente em ${selector}`)
  return declaration
    .slice(declaration.indexOf(':') + 1)
    .trim()
    .replace(/^\d+(\.\d+)?px solid\s+/, '')
}

const CONTROL = 3
const TEXT = 4.5

const PAIRS: { name: string; color: string; min: number }[] = [
  { name: 'borda de controle', color: 'var(--color-control-border)', min: CONTROL },
  { name: '.input', color: ruleColor('.input', 'border'), min: CONTROL },
  { name: '.btn-secondary', color: ruleColor('.btn-secondary', 'border-color'), min: CONTROL },
  { name: '.check .box', color: ruleColor('.check .box', 'border'), min: CONTROL },
  { name: '.switch .track', color: ruleColor('.switch .track', 'border'), min: CONTROL },
  { name: 'texto secundário', color: 'var(--color-text-muted)', min: TEXT },
  { name: 'texto de aviso', color: 'var(--color-warning)', min: TEXT },
  { name: 'texto de sucesso', color: 'var(--color-success)', min: TEXT },
  { name: 'texto de erro', color: 'var(--color-danger)', min: TEXT },
  { name: 'cabeçalho de tabela', color: ruleColor('.table th', 'color'), min: TEXT },
]

describe('contraste dos tokens do Design System', () => {
  for (const [theme, values] of [
    ['claro', LIGHT],
    ['escuro', DARK],
  ] as const) {
    for (const ground of ['--color-bg', '--color-surface']) {
      it.each(PAIRS)(`$name no tema ${theme} sobre ${ground}`, ({ color, min }) => {
        const under = resolve(values[ground], values, [0, 0, 0])
        expect(ratio(resolve(color, values, under), under)).toBeGreaterThanOrEqual(min)
      })
    }
  }
})
