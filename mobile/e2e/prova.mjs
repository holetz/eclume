// A prova do app móvel no emulador do host, contra o staging (holetz/eclume#41, 8.1; #91).
//
// Dirige o WebView do app pelo Playwright `_android` (o build de depuração do Tauri habilita a
// depuração do WebView), a tela bloqueada e a rede pelo `adb`, e a notificação pelo
// `uiautomator`. Confere no servidor, pela API com a conta de smoke, a gravação com a origem
// `mobile` e os marcadores. Roda de mobile/scripts/prova-emulador.sh, que sobe o emulador e
// instala o APK; a limpeza (gravações da prova, token do aparelho) é daqui.
//
// Variáveis: ECLUME_SMOKE_PASSWORD (obrigatória), ECLUME_URL (https://127.0.0.1:18444, o
// `staging.sh subir`, alcançado pelo `adb reverse`), ECLUME_SMOKE_EMAIL (staging@eclume.invalid),
// ECLUME_CA (PEM da CA raiz). A prova escreve: recusa a URL de produção.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import https from 'node:https'
import { _android as android } from 'playwright'

const PACOTE = 'io.github.holetz.eclume.movel'
const URL_SERVIDOR = process.env.ECLUME_URL ?? 'https://127.0.0.1:18444'
const PRODUCAO = ['https://192.168.15.199:8443', process.env.ECLUME_PUBLIC_URL].filter(Boolean)
const EMAIL = process.env.ECLUME_SMOKE_EMAIL ?? 'staging@eclume.invalid'
const SENHA = process.env.ECLUME_SMOKE_PASSWORD
const CA = readFileSync(process.env.ECLUME_CA ?? 'eclume-root.crt')
const TITULO = `Prova emulador ${new Date().toISOString().slice(0, 19)}`
const INICIO = Date.now()

if (PRODUCAO.some((u) => new URL(u).host === new URL(URL_SERVIDOR).host)) {
  console.error(`FALHA: ${URL_SERVIDOR} é a produção; a prova escreve: use o staging`)
  process.exit(2)
}
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
  // Logo depois de um `am force-stop`, o driver ainda pode entregar o WebView do processo morto:
  // uma página que fecha na mão pede outra.
  const pagina = await ate(
    'o WebView do app',
    async () => {
      const webview = await device.webView({ pkg: PACOTE }, { timeout: 60_000 })
      const candidata = await webview.page()
      await candidata.waitForSelector('.m-app', { timeout: 20_000 })
      return candidata
    },
    120,
  )
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
/** Os jobs do WorkManager do app (o SyncWorker), pelo `dumpsys jobscheduler`. */
function jobsDoSyncWorker() {
  const saida = adb('shell', 'dumpsys', 'jobscheduler')
  const ids = new Set()
  for (const linha of saida.split('\n')) {
    const achado = linha.match(/JOB #u[0-9a-z]*\/(\d+): .*br\.com\.holetz\.eclume\.movel\/.*SystemJobService/)
    if (achado) ids.add(achado[1])
  }
  return [...ids]
}

/** Roda já os jobs do SyncWorker, sem esperar as restrições nem o agendamento. */
function forcarSyncWorker() {
  const ids = jobsDoSyncWorker()
  if (ids.length === 0) throw new Error('nenhum job do SyncWorker agendado')
  for (const id of ids) adb('shell', 'cmd', 'jobscheduler', 'run', '-f', PACOTE, id)
  return ids
}

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

  // O AVD guarda o Wi‑Fi desligado de uma prova que caiu no meio: a prova parte dele ligado.
  adb('shell', 'svc', 'wifi', 'enable')
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

  // Tela bloqueada e Doze forçado (fora da tomada, ocioso) por 60 s: o serviço de microfone em
  // primeiro plano segue gravando.
  adb('shell', 'input', 'keyevent', 'KEYCODE_SLEEP')
  adb('shell', 'dumpsys', 'battery', 'unplug')
  adb('shell', 'dumpsys', 'deviceidle', 'force-idle')
  passo('tela bloqueada e Doze forçado (deviceidle force-idle); 60 s')
  await esperar(60_000)
  adb('shell', 'dumpsys', 'deviceidle', 'unforce')
  adb('shell', 'dumpsys', 'battery', 'reset')
  if (!servicoEmPrimeiroPlano()) throw new Error('o serviço caiu com a tela bloqueada no Doze')
  adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP')
  await tocarNaNotificacao(device, 'Marcador')
  passo('marcador pela notificação')

  pagina = await abrirApp(device)
  await ate('dois marcadores na tela', async () => (await pagina.locator('ul.markers li').count()) === 2, 20)
  const audio = await pagina.getByLabel('Tempo de áudio').textContent()
  const [h, m, s] = audio.split(':').map(Number)
  if (h * 3600 + m * 60 + s < 60) throw new Error(`tempo de áudio curto demais: ${audio}`)
  passo(`tempo de áudio ${audio}, com a tela bloqueada e o Doze contados`)

  // Fora da rede: nada sobe; parar e dar título. O app lê o Wi‑Fi a cada 5 s, e o emulador
  // segue alcançando o servidor pelos dados móveis: parar antes de ele notar subiria já.
  adb('shell', 'svc', 'wifi', 'disable')
  await ate(
    'o app notar o Wi‑Fi desligado',
    async () => (await pagina.evaluate(() => window.__TAURI_INTERNALS__.invoke('estado'))).rede.estado === 'away',
    30,
  )
  await pagina.getByText('Pausar').waitFor()
  await pagina.getByRole('button', { name: 'Parar' }).click()
  await pagina.getByLabel('Título (opcional)').fill(TITULO)
  await pagina.getByRole('button', { name: 'Salvar' }).click()
  await pagina.getByText('Fora da rede do eclume').waitFor({ timeout: 30_000 })
  await pagina.getByText('1 aguardando').first().waitFor({ timeout: 10_000 })
  passo('fora da rede: 1 aguardando')

  // De volta à rede com o app morto: só o SyncWorker do WorkManager sobe a gravação.
  adb('shell', 'input', 'keyevent', 'KEYCODE_HOME')
  await esperar(2000)
  adb('shell', 'am', 'kill', PACOTE)
  passo('app em segundo plano e morto (am kill)')
  adb('shell', 'svc', 'wifi', 'enable')
  await esperar(5000)
  passo(`SyncWorker forçado (jobs ${forcarSyncWorker().join(', ')}), sem abrir o app`)
  await entrarNaApi()
  const noServidor = await ate(
    'a gravação no servidor pelo SyncWorker',
    async () => (await gravacoesDaProva()).find((g) => g.title === TITULO),
    180,
  )
  passo('de volta à rede: subiu pelo worker, com o app fechado')
  pagina = await abrirApp(device)
  if (noServidor.source !== 'mobile') throw new Error(`source ${noServidor.source}`)
  if (noServidor.recorded_at_source !== 'capture') throw new Error(`recorded_at_source ${noServidor.recorded_at_source}`)
  const marcadores = await pedir('GET', `/api/v1/recordings/${noServidor.id}/markers`)
  const notas = marcadores.json.items.map((m) => m.note)
  if (marcadores.json.items.length !== 2 || !notas.includes('prova tela')) {
    throw new Error(`marcadores no servidor: ${JSON.stringify(marcadores.json.items)}`)
  }
  passo(`no servidor: ${noServidor.id}, source mobile, 2 marcadores (${marcadores.json.items[0].device_name})`)

  // Queda do processo no meio de uma gravação: fica salva como interrompida e, na rede do
  // eclume, sobe logo depois da reabertura.
  const locais = () => pagina.evaluate(() => window.__TAURI_INTERNALS__.invoke('gravacoes'))
  const anteriores = new Set((await locais()).map((g) => g.id))
  // Esta gravação começa pelo atalho "Gravar agora" do ícone: o mesmo intent do shortcuts.xml.
  adb('shell', 'am', 'start', '-a', `${PACOTE}.GRAVAR_AGORA`, '-n', `${PACOTE}/.MainActivity`)
  await pagina.getByText('Gravando', { exact: true }).waitFor({ timeout: 30_000 })
  await ate('o serviço de microfone em primeiro plano', () => servicoEmPrimeiroPlano(), 30)
  passo('gravando pelo atalho Gravar agora (GRAVAR_AGORA), com o serviço em primeiro plano')
  await esperar(5000)
  adb('shell', 'am', 'force-stop', PACOTE)
  passo('processo derrubado gravando (am force-stop)')
  pagina = await abrirApp(device)
  const recuperada = await ate('a gravação recuperada', async () =>
    (await locais()).find((g) => !anteriores.has(g.id) && ['interrompida', 'sincronizada'].includes(g.selo)),
  )
  passo(`reaberto: a gravação ficou salva (${recuperada.selo})`)
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
