// Orçamento do JS inicial do web: soma o <script type="module"> e os `modulepreload` do
// dist/index.html (bruto e gzip nível 9) e falha quando o gzip passa do teto de bundle-budget.json.
// Uso: npm run budget (depois do build) · node scripts/bundle-budget.mjs --teto-gzip <KB>
// Mudar o teto é editar o JSON no mesmo commit da mudança, com o motivo.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')
const html = readFileSync(join(dist, 'index.html'), 'utf8')
const tags = html.match(/<(script|link)\b[^>]*>/g) ?? []
const files = tags
  .filter((tag) => /type="module"/.test(tag) || /rel="modulepreload"/.test(tag))
  .map((tag) => /(?:src|href)="\/?([^"]+)"/.exec(tag)?.[1])
  .filter(Boolean)

const argIndex = process.argv.indexOf('--teto-gzip')
const budget =
  argIndex > 0
    ? Number(process.argv[argIndex + 1])
    : JSON.parse(readFileSync(join(root, 'bundle-budget.json'), 'utf8')).inicial_gzip_kb

let raw = 0
let gzip = 0
for (const file of files) {
  const content = readFileSync(join(dist, file))
  raw += content.length
  gzip += gzipSync(content, { level: 9 }).length
}
const kb = (bytes) => (bytes / 1000).toFixed(1)
console.log(`JS inicial: ${files.length} arquivos, ${kb(raw)} KB (${kb(gzip)} KB gzip); teto ${budget} KB gzip`)
if (files.length === 0 || !Number.isFinite(budget)) {
  console.error('Orçamento sem arquivos ou sem teto: confira o dist/index.html e o bundle-budget.json.')
  process.exit(2)
}
if (gzip / 1000 > budget) {
  console.error(`O JS inicial passou do teto em ${kb(gzip - budget * 1000)} KB gzip.`)
  process.exit(1)
}
