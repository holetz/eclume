// Referência navegável da API: gera dist/referencia-api.html do contracts/openapi-v1.bundled.yaml
// com o Redoc (redocly build-docs) e o modelo scripts/referencia-api.hbs. Roda no `npm run build`,
// depois do `vite build`. Norma em docs/standards/api/contrato-v1.md.
//
// O build-docs aponta o script do Redoc para a CDN e deixa o estado da página num <script> inline.
// Aqui os dois viram arquivos da mesma origem em dist/referencia-api/ (o redoc.standalone.js local
// é conferido contra o `integrity` que o build-docs gravou, o que prova a mesma versão), e o build
// falha se o HTML ainda carregar qualquer recurso de outra origem.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const contrato = join(root, '..', 'contracts', 'openapi-v1.bundled.yaml')
const saida = join(root, 'dist', 'referencia-api.html')
const pastaAssets = join(root, 'dist', 'referencia-api')

function falhar(motivo) {
  console.error(`referencia-api: ${motivo}`)
  process.exit(1)
}

// Cores do DS (design-system/styles.css) e fontes do sistema: nada a buscar fora.
const fonteTexto = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
const opcoes = {
  hideDownloadButtons: true,
  theme: {
    colors: {
      primary: { main: '#6f5a44' },
      text: { primary: '#262420', secondary: '#625b52' },
      border: { dark: '#7c746a', light: '#d8d3cb' },
    },
    typography: {
      fontFamily: fonteTexto,
      headings: { fontFamily: fonteTexto, fontWeight: '700' },
      code: { fontFamily: 'ui-monospace, Menlo, Consolas, monospace' },
      links: { color: '#6f5a44', visited: '#5e4c39', hover: '#4d3e2f' },
    },
    sidebar: { backgroundColor: '#ece8e2', textColor: '#262420' },
    rightPanel: { backgroundColor: '#2d2a26', textColor: '#f7f5f2' },
  },
}

const cli = require.resolve('@redocly/cli/bin/cli.js')
const resultado = spawnSync(
  process.execPath,
  [
    cli,
    'build-docs',
    contrato,
    '--output',
    saida,
    '--template',
    join(root, 'scripts', 'referencia-api.hbs'),
    '--title',
    'Referência da API — eclume',
    `--theme.openapi=${JSON.stringify(opcoes)}`,
  ],
  { stdio: 'inherit', env: { ...process.env, REDOCLY_TELEMETRY: 'off' } },
)
if (resultado.status !== 0) falhar(`redocly build-docs saiu com ${resultado.status}`)

let html = readFileSync(saida, 'utf8')
mkdirSync(pastaAssets, { recursive: true })

// 1. O script do Redoc: a cópia local, se for a mesma que a CDN serviria.
const tagCdn = html.match(/<script src="https?:\/\/[^"]*redoc\.standalone\.js" integrity="([^"]+)"[^>]*><\/script>/)
if (!tagCdn) falhar('o build-docs não gerou o <script> do Redoc esperado; confira a versão do @redocly/cli')
const redoc = readFileSync(require.resolve('redoc/bundles/redoc.standalone.js'))
const integridade = `sha384-${createHash('sha384').update(redoc).digest('base64')}`
if (integridade !== tagCdn[1]) {
  falhar(`o redoc local não é o que o @redocly/cli espera (${tagCdn[1]}); alinhe a versão do redoc no package.json`)
}
writeFileSync(join(pastaAssets, 'redoc.standalone.js'), redoc)
html = html.replace(tagCdn[0], '<script src="/referencia-api/redoc.standalone.js"></script>')

// 2. O estado e a hidratação saem do <script> inline para um arquivo (a CSP fica sem script inline).
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
if (inline.length !== 1 || !inline[0][1].includes('Redoc.hydrate')) {
  falhar(`esperava um único <script> inline com o Redoc.hydrate, achei ${inline.length}`)
}
writeFileSync(join(pastaAssets, 'estado.js'), inline[0][1])
html = html.replace(inline[0][0], '<script src="/referencia-api/estado.js"></script>')

// 3. Nenhum recurso de outra origem: src/srcset, <link href>, url() e @import do CSS.
const externos = [
  /\b(?:src|srcset)\s*=\s*["']?\s*(?:https?:)?\/\//gi,
  /<link\b[^>]*\bhref\s*=\s*["']?\s*(?:https?:)?\/\//gi,
  /url\(\s*["']?\s*(?:https?:)?\/\//gi,
  /@import\s+(?:url\()?\s*["']?\s*(?:https?:)?\/\//gi,
].flatMap((padrao) => html.match(padrao) ?? [])
if (externos.length > 0) falhar(`o HTML carrega recurso de outra origem: ${externos.join(' · ')}`)

writeFileSync(saida, html)
console.log(`referencia-api: ${saida} (${Math.ceil(Buffer.byteLength(html) / 1024)} KiB)`)
