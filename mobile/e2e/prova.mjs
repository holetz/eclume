// A prova do app móvel no emulador do host, contra a produção (holetz/eclume#41, 8.1).
//
// Dirige o WebView do app pelo Playwright `_android` (o build de depuração do Tauri habilita a
// depuração do WebView), a tela bloqueada e a rede pelo `adb`, e a notificação pelo
// `uiautomator`. Confere no servidor, pela API com a conta de smoke, a gravação com a origem
// `mobile` e os marcadores. Roda de mobile/scripts/prova-emulador.sh, que sobe o emulador e
// instala o APK; a limpeza (gravações da prova, token do aparelho) é daqui.
//
// Variáveis: ECLUME_SMOKE_PASSWORD (obrigatória), ECLUME_URL (https://192.168.15.199:8443),
// ECLUME_SMOKE_EMAIL (admin@example.com), ECLUME_CA (PEM da CA raiz).

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import https from 'node:https'
import { _android as android } from 'playwright'

const PACOTE = 'io.github.holetz.eclume.movel'
const URL_SERVIDOR = process.env.ECLUME_URL ?? 'https://192.168.15.199:8443'
const EMAIL = process.env.ECLUME_SMOKE_EMAIL ?? 'admin@example.com'
const SENHA = process.env.ECLUME_SMOKE_PASSWORD
const CA = readFileSync(process.env.ECLUME_CA ?? 'eclume-root.crt')
const TITULO = `Prova emulador ${new Date().toISOString().slice(0, 19)}`
const INICIO = Date.now()

if (!SENHA) {
  console.error('FALHA: informe ECLUME_SMOKE_PASSWORD')
  process.exit(2)
}

function passo(texto) {
  console.log(`· ${texto}`)
}

function adb(...args) {
  return execFileSync('adb', args, { encoding: 'utf8' }).trim()
}

const esperar = (ms) => new Promise((resolver) => setTimeout(resolver, ms))

async function ate(oQue, verificar, segundos = 60) {
  const limite = Date.now() + segundos * 1000
  let ultimo
  while (Date.now() < limite) {
    try {
      const valor = await verificar()
      if (valor) return valor
    } catch (erro) {
      ultimo = erro
    }
    await esperar(1000)
  }
  throw new Error(`tempo esgotado esperando ${oQue}${ultimo ? `: ${ultimo.message}` : ''}`)
}

// --- a API do servidor, com a sessão da conta de smoke -----------------------------------------

const cookies = new Map()

function pedir(metodo, caminho, corpo) {
  const url = new URL(caminho, URL_SERVIDOR)
  const dados = corpo === undefined ? undefined : JSON.stringify(corpo)
  const headers = { Accept: 'application/json' }
  if (dados) headers['Content-Type'] = 'application/json'
  if (cookies.size) headers.Cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ')
  if (cookies.has('eclume_csrf') && metodo !== 'GET') headers['X-CSRF-Token'] = cookies.get('eclume_csrf')
  return new Promise((resolver, rejeitar) => {
    const req = https.request(url, { method: metodo, headers, ca: CA }, (res) => {
      for (const linha of res.headers['set-cookie'] ?? []) {
        const [par] = linha.split(';')
        const i = par.indexOf('=')
        cookies.set(par.slice(0, i), par.slice(i + 1))
      }
      const partes = []
      res.on('data', (p) => partes.push(p))
      res.on('end', () => {
        const texto = Buffer.concat(partes).toString('utf8')
        resolver({ status: res.statusCode, json: texto ? JSON.parse(texto) : null })
      })
    })
    req.on('error', rejeitar)
    if (dados) req.write(dados)
    req.end()
  })
}

async function entrarNaApi() {
  const r = await pedir('POST', '/api/v1/auth/login', { email: EMAIL, password: SENHA })
  if (r.status !== 200 && r.status !== 204) throw new Error(`login na API → ${r.status}`)
}

async function gravacoesDaProva() {
  const r = await pedir('GET', '/api/v1/recordings?limit=50')
  if (r.status !== 200) throw new Error(`GET /recordings → ${r.status}`)
  return r.json.items.filter((g) => g.title?.startsWith('Prova emulador') || g.capture?.device_name === MODELO)
}

let MODELO = null
let PAGINA = null

async function limpar() {
  try {
    await entrarNaApi()
    for (const g of await gravacoesDaProva()) {
      if (Date.parse(g.created_at) < INICIO - 60_000) continue
      const r = await pedir('DELETE', `/api/v1/recordings/${g.id}`)
      console.log(`  limpeza: gravação ${g.id} → ${r.status}`)
    }
    const tokens = await pedir('GET', '/api/v1/tokens?kind=device')
    for (const t of tokens.json?.items ?? []) {
      if (t.name === MODELO && Date.parse(t.created_at) >= INICIO - 60_000 && !t.revoked_at) {
        const r = await pedir('DELETE', `/api/v1/tokens/${t.id}`)
        console.log(`  limpeza: token do aparelho ${t.id} → ${r.status}`)
      }
    }
  } catch (erro) {
    console.error(`  limpeza falhou: ${erro.message}`)
  }
}

// --- o app -------------------------------------------------------------------------------------

async function abrirApp(device) {
  adb('shell', 'monkey', '-p', PACOTE, '-c', 'android.intent.category.LAUNCHER', '1')
  const webview = await device.webView({ pkg: PACOTE }, { timeout: 60_000 })
  const pagina = await webview.page()
  await pagina.waitForSelector('.m-app', { timeout: 60_000 })
  PAGINA = pagina
  return pagina
}

function servicoEmPrimeiroPlano() {
  const saida = adb('shell', 'dumpsys', 'activity', 'services', PACOTE)
  return saida.includes('ServicoDeGravacao') && /isForeground=true/.test(saida) ? saida : null
}

/** Toca numa ação da notificação da gravação, pela aba de notificações do sistema. O driver do
 * Playwright acha o botão pelo texto (o `uiautomator dump` não serve: o cronômetro da notificação
 * nunca deixa a tela ociosa). */
async function tocarNaNotificacao(device, texto) {
  adb('shell', 'wm', 'dismiss-keyguard')
  adb('shell', 'input', 'keyevent', 'KEYCODE_HOME')
  adb('shell', 'cmd', 'statusbar', 'expand-notifications')
  const botao = { text: texto, pkg: 'com.android.systemui' }
  await device.wait(botao, { timeout: 20_000 })
  await device.tap(botao)
  adb('shell', 'cmd', 'statusbar', 'collapse')
}

async function principal() {
  MODELO = adb('shell', 'getprop', 'ro.product.model')
  passo(`aparelho ${MODELO}, servidor ${URL_SERVIDOR}`)
  const [device] = await android.devices()
  if (!device) throw new Error('nenhum aparelho no adb')

  let pagina = await abrirApp(device)
  passo('app aberto; primeira execução')

  // Entrar pelo endereço digitado, conferindo a impressão digital.
  await pagina.getByRole('button', { name: 'Digitar o endereço' }).click()
  await pagina.getByLabel('Endereço do servidor').fill(new URL(URL_SERVIDOR).host)
  await pagina.getByRole('button', { name: 'Continuar' }).click()
  const impressao = await pagina.getByLabel('Impressão digital do certificado').textContent({ timeout: 30_000 })
  const info = await pedir('GET', '/api/v1/server')
  const esperada = info.json.ca_sha256.toUpperCase().match(/.{4}/g).join(' ')
  if (impressao.trim() !== esperada) throw new Error(`impressão ${impressao} ≠ ${esperada}`)
  passo('impressão digital confere com o /server; confiando')
  await pagina.getByRole('button', { name: 'Confiar' }).click()
  await pagina.getByLabel('E-mail').fill(EMAIL)
  await pagina.getByLabel('Senha').fill(SENHA)
  await pagina.getByRole('button', { name: 'Entrar' }).click()
  await pagina.getByText('Na rede do eclume').waitFor({ timeout: 60_000 })
  passo('entrou; na rede do eclume')

  // Gravar, marcar pela tela com nota, bloquear a tela por 60 s, marcar pela notificação.
  await pagina.getByRole('button', { name: /Gravar/ }).click()
  await pagina.getByText('Gravando', { exact: true }).waitFor({ timeout: 30_000 })
  await ate('o serviço de microfone em primeiro plano', () => servicoEmPrimeiroPlano(), 30)
  passo('gravando, com o serviço de microfone em primeiro plano')
  await esperar(3000)
  await pagina.getByRole('button', { name: 'Marcador' }).click()
  await pagina.getByPlaceholder('Nota (opcional)').fill('prova tela')
  await pagina.getByRole('button', { name: 'Adicionar' }).click()
  passo('marcador pela tela, com nota')

  adb('shell', 'input', 'keyevent', 'KEYCODE_SLEEP')
  passo('tela bloqueada; 60 s')
  await esperar(60_000)
  if (!servicoEmPrimeiroPlano()) throw new Error('o serviço caiu com a tela bloqueada')
  adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP')
  await tocarNaNotificacao(device, 'Marcador')
  passo('marcador pela notificação')

  pagina = await abrirApp(device)
  await ate('dois marcadores na tela', async () => (await pagina.locator('ul.markers li').count()) === 2, 20)
  const audio = await pagina.getByLabel('Tempo de áudio').textContent()
  const [h, m, s] = audio.split(':').map(Number)
  if (h * 3600 + m * 60 + s < 60) throw new Error(`tempo de áudio curto demais: ${audio}`)
  passo(`tempo de áudio ${audio}, com a tela bloqueada contada`)

  // Fora da rede: nada sobe; parar e dar título.
  adb('shell', 'svc', 'wifi', 'disable')
  await pagina.getByText('Pausar').waitFor()
  await pagina.getByRole('button', { name: 'Parar' }).click()
  await pagina.getByLabel('Título (opcional)').fill(TITULO)
  await pagina.getByRole('button', { name: 'Salvar' }).click()
  await pagina.getByText('Fora da rede do eclume').waitFor({ timeout: 30_000 })
  await pagina.getByText('1 aguardando').first().waitFor({ timeout: 10_000 })
  passo('fora da rede: 1 aguardando')

  // De volta à rede: sincroniza sozinho.
  adb('shell', 'svc', 'wifi', 'enable')
  await ate(
    'a gravação sincronizada',
    async () => (await pagina.getByText(TITULO).count()) > 0 && (await pagina.getByText('Sincronizada').count()) > 0,
    120,
  )
  passo('de volta à rede: sincronizada')

  await entrarNaApi()
  const noServidor = await ate('a gravação no servidor', async () =>
    (await gravacoesDaProva()).find((g) => g.title === TITULO),
  )
  if (noServidor.source !== 'mobile') throw new Error(`source ${noServidor.source}`)
  if (noServidor.recorded_at_source !== 'capture') throw new Error(`recorded_at_source ${noServidor.recorded_at_source}`)
  const marcadores = await pedir('GET', `/api/v1/recordings/${noServidor.id}/markers`)
  const notas = marcadores.json.items.map((m) => m.note)
  if (marcadores.json.items.length !== 2 || !notas.includes('prova tela')) {
    throw new Error(`marcadores no servidor: ${JSON.stringify(marcadores.json.items)}`)
  }
  passo(`no servidor: ${noServidor.id}, source mobile, 2 marcadores (${marcadores.json.items[0].device_name})`)

  // Queda do processo no meio de uma gravação: fica salva como interrompida.
  await pagina.getByRole('button', { name: /Gravar/ }).click()
  await pagina.getByText('Gravando', { exact: true }).waitFor({ timeout: 30_000 })
  await esperar(5000)
  adb('shell', 'am', 'force-stop', PACOTE)
  passo('processo derrubado gravando (am force-stop)')
  pagina = await abrirApp(device)
  await pagina.getByText('Interrompida').first().waitFor({ timeout: 30_000 })
  passo('reaberto: a gravação ficou salva como Interrompida')
}

let codigo = 0
try {
  await principal()
  passo('prova concluída')
} catch (erro) {
  console.error(`FALHA: ${erro.stack ?? erro}`)
  codigo = 1
  // O que a tela mostrava e o log do app, para diagnosticar.
  const texto = await PAGINA?.evaluate(() => document.body.innerText).catch((e) => `(sem tela: ${e.message})`)
  console.error(`--- tela ---\n${texto}`)
  const estado = await PAGINA?.evaluate(() => window.__TAURI_INTERNALS__.invoke('estado'))
    .then((e) => JSON.stringify(e))
    .catch((e) => `(sem estado: ${e.message})`)
  console.error(`--- estado ---\n${estado}`)
  const locais = await PAGINA?.evaluate(() => window.__TAURI_INTERNALS__.invoke('gravacoes'))
    .then((g) => JSON.stringify(g.map((x) => ({ id: x.id, selo: x.selo, erro: x.ultimo_erro }))))
    .catch((e) => `(sem gravações: ${e.message})`)
  console.error(`--- gravações ---\n${locais}`)
  const log = adb('logcat', '-d', '-s', 'eclume:*').split('\n').slice(-40).join('\n')
  console.error(`--- logcat (eclume) ---\n${log}`)
} finally {
  await limpar()
}
process.exit(codigo)
