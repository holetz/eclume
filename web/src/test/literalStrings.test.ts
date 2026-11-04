// No literal UI string in the directories already translated: their text comes from the i18n catalogs
// (`src/i18n/<locale>/<namespace>.ts`). A spec that translates another folder adds it to `COVERED`.
// A line that must keep a literal (a brand name, a format sample) carries `i18n-ignore` on it or on the
// line above, with the reason.
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/** The translated directories, relative to `web/`. */
const COVERED = ['src/i18n', 'src/app', 'src/shared', 'src/features/auth', 'src/features/account', 'src/features/connect']

/** The catalogs themselves are literal by nature. */
const EXEMPT = [/^src\/i18n\/(en|pt-BR)\//, /\.test\.tsx?$/, /\.d\.ts$/]

/** JSX attributes a person reads or hears. */
const VISIBLE_ATTRIBUTES = new Set([
  'aria-label',
  'aria-description',
  'aria-roledescription',
  'aria-valuetext',
  'title',
  'placeholder',
  'alt',
  'label',
  'kicker',
  'description',
  'hint',
  'emptyText',
  'confirmLabel',
  'cancelLabel',
])

/** Object properties that hold UI text outside JSX (nav items, option lists, messages). */
const TEXT_PROPERTIES = new Set(['label', 'title', 'description', 'hint', 'message', 'kicker', 'text', 'placeholder'])

const LETTER = /\p{L}/u

interface Finding {
  file: string
  line: number
  text: string
}

function hasText(value: string): boolean {
  return LETTER.test(value)
}

/** The literal parts of a string-like expression, or `null` when it is not one. */
function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(' ')
  if (ts.isParenthesizedExpression(node)) return literalText(node.expression)
  if (ts.isConditionalExpression(node)) {
    const parts = [literalText(node.whenTrue), literalText(node.whenFalse)].filter((part) => part !== null)
    return parts.length ? parts.join(' ') : null
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.BarBarToken) return literalText(node.right)
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) return literalText(node.right)
  return null
}

/** The literal UI strings of one source file. */
function findLiterals(file: string, source: string): Finding[] {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind)
  const lines = source.split('\n')
  const findings: Finding[] = []

  function report(node: ts.Node, text: string) {
    // JSX text starts at the whitespace after the previous tag: report the line of its first letter.
    const start = ts.isJsxText(node) ? node.pos + Math.max(node.text.search(/\S/), 0) : node.getStart(sf)
    const line = sf.getLineAndCharacterOfPosition(start).line
    if (lines[line]?.includes('i18n-ignore') || lines[line - 1]?.includes('i18n-ignore')) return
    findings.push({ file, line: line + 1, text: text.trim().replace(/\s+/g, ' ') })
  }

  function visit(node: ts.Node) {
    if (ts.isJsxText(node) && hasText(node.text)) report(node, node.text)
    else if (ts.isJsxExpression(node) && node.expression && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      const text = literalText(node.expression)
      if (text !== null && hasText(text)) report(node, text)
    } else if (ts.isJsxAttribute(node) && VISIBLE_ATTRIBUTES.has(node.name.getText(sf)) && node.initializer) {
      const value = ts.isJsxExpression(node.initializer) ? node.initializer.expression : node.initializer
      const text = value ? literalText(value) : null
      if (text !== null && hasText(text)) report(node, text)
    } else if (ts.isPropertyAssignment(node) && TEXT_PROPERTIES.has(node.name.getText(sf).replace(/['"]/g, ''))) {
      const text = literalText(node.initializer)
      if (text !== null && hasText(text)) report(node, text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return findings
}

const sources = import.meta.glob<string>('/src/**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true })

function coveredSources(): [string, string][] {
  return Object.entries(sources)
    .map(([path, text]): [string, string] => [path.replace(/^\//, ''), text])
    .filter(([path]) => COVERED.some((dir) => path.startsWith(`${dir}/`)))
    .filter(([path]) => !EXEMPT.some((pattern) => pattern.test(path)))
}

describe('literal UI strings', () => {
  it('flags JSX text, visible attributes and text properties', () => {
    const source = [
      'export const items = [{ label: "Library" }]',
      'export function A() {',
      '  return <p title="Hint">Hello <b>{"world"}</b> <i aria-label={`Open ${1}`} />{1}</p>',
      '}',
    ].join('\n')
    const texts = findLiterals('fixture.tsx', source).map((finding) => finding.text)
    expect(texts).toEqual(['Library', 'Hint', 'Hello', 'world', 'Open'])
  })

  it('accepts translated text, non-text values and an i18n-ignore line', () => {
    const source = [
      'export function A({ t }: { t: (key: string) => string }) {',
      '  return (',
      '    <p title={t("shell:hint")} className="mono" aria-hidden="true">',
      '      {t("shell:hello")} · {42} — …',
      '      {/* i18n-ignore: the brand */}',
      '      eclume',
      '    </p>',
      '  )',
      '}',
    ].join('\n')
    expect(findLiterals('fixture.tsx', source)).toEqual([])
  })

  it('finds no literal UI string in the covered directories', () => {
    const files = coveredSources()
    expect(files.length).toBeGreaterThan(0)
    const findings = files.flatMap(([path, text]) => findLiterals(path, text))
    expect(findings.map((f) => `${f.file}:${f.line} ${f.text}`)).toEqual([])
  })
})
