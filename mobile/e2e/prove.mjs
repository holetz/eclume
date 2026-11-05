// The mobile app's proof on the host's emulator, against staging (holetz/eclume#41, 8.1; #91).
//
// Drives the app's WebView through Playwright `_android` (Tauri's debug build enables WebView
// debugging), the lock screen and the network through `adb`, and the notification through
// `uiautomator`. Checks on the server, through the API with the smoke account, the recording with
// the `mobile` source and the markers. Runs from mobile/scripts/prove-emulator.sh, which starts the
// emulator and installs the APK; the cleanup (the proof's recordings, the device token) is done here.
//
// Variables: ECLUME_SMOKE_PASSWORD (required), ECLUME_URL (https://127.0.0.1:18444, `staging.sh
// up`, reached through `adb reverse`), ECLUME_SMOKE_EMAIL (staging@eclume.invalid), ECLUME_CA (the
// root CA PEM). The proof writes: it refuses the production URL.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import https from 'node:https'
import { _android as android } from 'playwright'

const PACKAGE = 'io.github.holetz.eclume.movel'
const SERVER_URL = process.env.ECLUME_URL ?? 'https://127.0.0.1:18444'
const PRODUCTION = [process.env.ECLUME_PUBLIC_URL].filter(Boolean)
const EMAIL = process.env.ECLUME_SMOKE_EMAIL ?? 'staging@eclume.invalid'
const PASSWORD = process.env.ECLUME_SMOKE_PASSWORD
const CA = readFileSync(process.env.ECLUME_CA ?? 'eclume-root.crt')
const TITLE_PREFIX = 'Emulator proof'
const TITLE = `${TITLE_PREFIX} ${new Date().toISOString().slice(0, 19)}`
const START = Date.now()

if (PRODUCTION.some((u) => new URL(u).host === new URL(SERVER_URL).host)) {
  console.error(`FAILED: ${SERVER_URL} is production; the proof writes: use staging`)
  process.exit(2)
}
if (!PASSWORD) {
  console.error('FAILED: set ECLUME_SMOKE_PASSWORD')
  process.exit(2)
}

function step(text) {
  console.log(`· ${text}`)
}

function adb(...args) {
  return execFileSync('adb', args, { encoding: 'utf8' }).trim()
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(what, check, seconds = 60) {
  const deadline = Date.now() + seconds * 1000
  let last
  while (Date.now() < deadline) {
    try {
      const value = await check()
      if (value) return value
    } catch (error) {
      last = error
    }
    await sleep(1000)
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ''}`)
}

// --- the server API, with the smoke account's session ------------------------------------------

const cookies = new Map()

function request(method, path, body) {
  const url = new URL(path, SERVER_URL)
  const data = body === undefined ? undefined : JSON.stringify(body)
  const headers = { Accept: 'application/json' }
  if (data) headers['Content-Type'] = 'application/json'
  if (cookies.size) headers.Cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ')
  if (cookies.has('eclume_csrf') && method !== 'GET') headers['X-CSRF-Token'] = cookies.get('eclume_csrf')
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers, ca: CA }, (res) => {
      for (const line of res.headers['set-cookie'] ?? []) {
        const [pair] = line.split(';')
        const i = pair.indexOf('=')
        cookies.set(pair.slice(0, i), pair.slice(i + 1))
      }
      const chunks = []
      res.on('data', (p) => chunks.push(p))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve({ status: res.statusCode, json: text ? JSON.parse(text) : null })
      })
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

async function signInToApi() {
  const r = await request('POST', '/api/v1/auth/login', { email: EMAIL, password: PASSWORD })
  if (r.status !== 200 && r.status !== 204) throw new Error(`API login → ${r.status}`)
}

async function proofRecordings() {
  const r = await request('GET', '/api/v1/recordings?limit=50')
  if (r.status !== 200) throw new Error(`GET /recordings → ${r.status}`)
  return r.json.items.filter((g) => g.title?.startsWith(TITLE_PREFIX) || g.capture?.device_name === MODEL)
}

let MODEL = null
let PAGE = null

async function cleanUp() {
  try {
    await signInToApi()
    for (const g of await proofRecordings()) {
      if (Date.parse(g.created_at) < START - 60_000) continue
      const r = await request('DELETE', `/api/v1/recordings/${g.id}`)
      console.log(`  cleanup: recording ${g.id} → ${r.status}`)
    }
    const tokens = await request('GET', '/api/v1/tokens?kind=device')
    for (const t of tokens.json?.items ?? []) {
      if (t.name === MODEL && Date.parse(t.created_at) >= START - 60_000 && !t.revoked_at) {
        const r = await request('DELETE', `/api/v1/tokens/${t.id}`)
        console.log(`  cleanup: device token ${t.id} → ${r.status}`)
      }
    }
  } catch (error) {
    console.error(`  cleanup failed: ${error.message}`)
  }
}

// --- the app -----------------------------------------------------------------------------------

async function openApp(device) {
  adb('shell', 'monkey', '-p', PACKAGE, '-c', 'android.intent.category.LAUNCHER', '1')
  // Right after an `am force-stop`, the driver may still hand over the dead process's WebView: a
  // page that closes in hand asks for another.
  const page = await until(
    "the app's WebView",
    async () => {
      const webview = await device.webView({ pkg: PACKAGE }, { timeout: 60_000 })
      const candidate = await webview.page()
      await candidate.waitForSelector('.m-app', { timeout: 20_000 })
      return candidate
    },
    120,
  )
  PAGE = page
  return page
}

function serviceInForeground() {
  const output = adb('shell', 'dumpsys', 'activity', 'services', PACKAGE)
  return output.includes('RecordingService') && /isForeground=true/.test(output) ? output : null
}

/** The app's WorkManager jobs (the SyncWorker), through `dumpsys jobscheduler`. */
function syncWorkerJobs() {
  const output = adb('shell', 'dumpsys', 'jobscheduler')
  const ids = new Set()
  for (const line of output.split('\n')) {
    const found = line.match(/JOB #u[0-9a-z]*\/(\d+): .*br\.com\.holetz\.eclume\.movel\/.*SystemJobService/)
    if (found) ids.add(found[1])
  }
  return [...ids]
}

/** Runs the SyncWorker jobs now, without waiting for the constraints nor the schedule. */
function forceSyncWorker() {
  const ids = syncWorkerJobs()
  if (ids.length === 0) throw new Error('no SyncWorker job scheduled')
  for (const id of ids) adb('shell', 'cmd', 'jobscheduler', 'run', '-f', PACKAGE, id)
  return ids
}

/** Taps an action of the recording notification, through the system notification shade. The
 * Playwright driver finds the button by its text (`uiautomator dump` does not work: the
 * notification's chronometer never lets the screen go idle). */
async function tapNotification(device, text) {
  adb('shell', 'wm', 'dismiss-keyguard')
  adb('shell', 'input', 'keyevent', 'KEYCODE_HOME')
  adb('shell', 'cmd', 'statusbar', 'expand-notifications')
  const button = { text, pkg: 'com.android.systemui' }
  await device.wait(button, { timeout: 20_000 })
  await device.tap(button)
  adb('shell', 'cmd', 'statusbar', 'collapse')
}

async function main() {
  MODEL = adb('shell', 'getprop', 'ro.product.model')
  step(`device ${MODEL}, server ${SERVER_URL}`)
  const [device] = await android.devices()
  if (!device) throw new Error('no device on adb')

  // The AVD keeps the Wi‑Fi off from a proof that died midway: the proof starts with it on.
  adb('shell', 'svc', 'wifi', 'enable')
  let page = await openApp(device)
  step('app open; first run')

  // Sign in through the typed address, checking the fingerprint.
  await page.getByRole('button', { name: 'Digitar o endereço' }).click()
  await page.getByLabel('Endereço do servidor').fill(new URL(SERVER_URL).host)
  await page.getByRole('button', { name: 'Continuar' }).click()
  const fingerprint = await page.getByLabel('Impressão digital do certificado').textContent({ timeout: 30_000 })
  const info = await request('GET', '/api/v1/server')
  const expected = info.json.ca_sha256.toUpperCase().match(/.{4}/g).join(' ')
  if (fingerprint.trim() !== expected) throw new Error(`fingerprint ${fingerprint} ≠ ${expected}`)
  step('the fingerprint matches /server; trusting')
  await page.getByRole('button', { name: 'Confiar' }).click()
  await page.getByLabel('E-mail').fill(EMAIL)
  await page.getByLabel('Senha').fill(PASSWORD)
  await page.getByRole('button', { name: 'Entrar' }).click()
  await page.getByText('Na rede do eclume').waitFor({ timeout: 60_000 })
  step("signed in; on eclume's network")

  // Record, mark from the screen with a note, lock the screen for 60 s, mark from the notification.
  await page.getByRole('button', { name: /Gravar/ }).click()
  await page.getByText('Gravando', { exact: true }).waitFor({ timeout: 30_000 })
  await until('the microphone service in the foreground', () => serviceInForeground(), 30)
  step('recording, with the microphone service in the foreground')
  await sleep(3000)
  await page.getByRole('button', { name: 'Marcador' }).click()
  await page.getByPlaceholder('Nota (opcional)').fill('prova tela')
  await page.getByRole('button', { name: 'Adicionar' }).click()
  step('marker from the screen, with a note')

  // Screen locked and Doze forced (unplugged, idle) for 60 s: the microphone foreground service
  // keeps recording.
  adb('shell', 'input', 'keyevent', 'KEYCODE_SLEEP')
  adb('shell', 'dumpsys', 'battery', 'unplug')
  adb('shell', 'dumpsys', 'deviceidle', 'force-idle')
  step('screen locked and Doze forced (deviceidle force-idle); 60 s')
  await sleep(60_000)
  adb('shell', 'dumpsys', 'deviceidle', 'unforce')
  adb('shell', 'dumpsys', 'battery', 'reset')
  if (!serviceInForeground()) throw new Error('the service died with the screen locked in Doze')
  adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP')
  await tapNotification(device, 'Marcador')
  step('marker from the notification')

  page = await openApp(device)
  await until('two markers on the screen', async () => (await page.locator('ul.markers li').count()) === 2, 20)
  const audio = await page.getByLabel('Tempo de áudio').textContent()
  const [h, m, s] = audio.split(':').map(Number)
  if (h * 3600 + m * 60 + s < 60) throw new Error(`audio time too short: ${audio}`)
  step(`audio time ${audio}, with the locked screen and Doze counted`)

  // Off the network: nothing uploads; stop and give a title. The app reads the Wi‑Fi every 5 s, and
  // the emulator keeps reaching the server over mobile data: stopping before it notices would upload
  // right away.
  adb('shell', 'svc', 'wifi', 'disable')
  await until(
    'the app noticing the Wi‑Fi off',
    async () => (await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('estado'))).rede.estado === 'away',
    30,
  )
  await page.getByText('Pausar').waitFor()
  await page.getByRole('button', { name: 'Parar' }).click()
  await page.getByLabel('Título (opcional)').fill(TITLE)
  await page.getByRole('button', { name: 'Salvar' }).click()
  await page.getByText('Fora da rede do eclume').waitFor({ timeout: 30_000 })
  await page.getByText('1 aguardando').first().waitFor({ timeout: 10_000 })
  step('off the network: 1 pending')

  // Back on the network with the app dead: only WorkManager's SyncWorker uploads the recording.
  adb('shell', 'input', 'keyevent', 'KEYCODE_HOME')
  await sleep(2000)
  adb('shell', 'am', 'kill', PACKAGE)
  step('app in the background and killed (am kill)')
  adb('shell', 'svc', 'wifi', 'enable')
  await sleep(5000)
  step(`SyncWorker forced (jobs ${forceSyncWorker().join(', ')}), without opening the app`)
  await signInToApi()
  const onServer = await until(
    'the recording on the server through the SyncWorker',
    async () => (await proofRecordings()).find((g) => g.title === TITLE),
    180,
  )
  step('back on the network: uploaded by the worker, with the app closed')
  page = await openApp(device)
  if (onServer.source !== 'mobile') throw new Error(`source ${onServer.source}`)
  if (onServer.recorded_at_source !== 'capture') throw new Error(`recorded_at_source ${onServer.recorded_at_source}`)
  const markers = await request('GET', `/api/v1/recordings/${onServer.id}/markers`)
  const notes = markers.json.items.map((m) => m.note)
  if (markers.json.items.length !== 2 || !notes.includes('prova tela')) {
    throw new Error(`markers on the server: ${JSON.stringify(markers.json.items)}`)
  }
  step(`on the server: ${onServer.id}, source mobile, 2 markers (${markers.json.items[0].device_name})`)

  // The process dies mid-recording: it stays saved as interrupted and, on eclume's network, uploads
  // right after reopening.
  const local = () => page.evaluate(() => window.__TAURI_INTERNALS__.invoke('gravacoes'))
  const before = new Set((await local()).map((g) => g.id))
  // This recording starts from the launcher icon's record-now shortcut: the same intent as shortcuts.xml.
  adb('shell', 'am', 'start', '-a', `${PACKAGE}.GRAVAR_AGORA`, '-n', `${PACKAGE}/.MainActivity`)
  await page.getByText('Gravando', { exact: true }).waitFor({ timeout: 30_000 })
  await until('the microphone service in the foreground', () => serviceInForeground(), 30)
  step('recording from the record-now shortcut (GRAVAR_AGORA), with the service in the foreground')
  await sleep(5000)
  adb('shell', 'am', 'force-stop', PACKAGE)
  step('process killed while recording (am force-stop)')
  page = await openApp(device)
  const recovered = await until('the recovered recording', async () =>
    (await local()).find((g) => !before.has(g.id) && ['interrompida', 'sincronizada'].includes(g.selo)),
  )
  step(`reopened: the recording stayed saved (${recovered.selo})`)
}

let code = 0
try {
  await main()
  step('proof done')
} catch (error) {
  console.error(`FAILED: ${error.stack ?? error}`)
  code = 1
  // What the screen showed and the app's log, to diagnose.
  const text = await PAGE?.evaluate(() => document.body.innerText).catch((e) => `(no screen: ${e.message})`)
  console.error(`--- screen ---\n${text}`)
  const state = await PAGE?.evaluate(() => window.__TAURI_INTERNALS__.invoke('estado'))
    .then((e) => JSON.stringify(e))
    .catch((e) => `(no state: ${e.message})`)
  console.error(`--- state ---\n${state}`)
  const local = await PAGE?.evaluate(() => window.__TAURI_INTERNALS__.invoke('gravacoes'))
    .then((g) => JSON.stringify(g.map((x) => ({ id: x.id, selo: x.selo, erro: x.ultimo_erro }))))
    .catch((e) => `(no recordings: ${e.message})`)
  console.error(`--- recordings ---\n${local}`)
  const log = adb('logcat', '-d', '-s', 'eclume:*').split('\n').slice(-40).join('\n')
  console.error(`--- logcat (eclume) ---\n${log}`)
} finally {
  await cleanUp()
}
process.exit(code)
