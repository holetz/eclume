// Manual demo of the conversion library (only under `npm run dev`, at /media-convert.html).
import {
  checkEnvironment,
  convertAudio,
  MediaConvertError,
  OUTPUT_FORMAT,
  probeMedia,
} from '../lib/media-convert'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const fileInput = $<HTMLInputElement>('arquivo')
const convertButton = $<HTMLButtonElement>('converter')
const cancelButton = $<HTMLButtonElement>('cancelar')
const progressBar = $<HTMLProgressElement>('progresso')
const statusLine = $('estado')
const resultList = $('resultado')
const player = $<HTMLAudioElement>('ouvir')

const mb = (bytes: number) => `${(bytes / 1_000_000).toFixed(2)} MB`

const env = checkEnvironment()
$('ambiente').textContent =
  `Contexto seguro: ${env.secureContext ? 'sim' : 'não (a conversão exige HTTPS)'} · ` +
  `WebCodecs: ${env.webCodecs ? 'sim' : 'não (usará ffmpeg.wasm)'}`

let controller: AbortController | null = null

function row(term: string, value: string | Node): [HTMLElement, HTMLElement] {
  const dd = document.createElement('dd')
  dd.append(value)
  return [Object.assign(document.createElement('dt'), { textContent: term }), dd]
}

function showError(error: unknown) {
  statusLine.className = 'erro'
  statusLine.textContent =
    error instanceof MediaConvertError ? `${error.message} (${error.code})` : String(error)
}

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0]
  resultList.hidden = player.hidden = true
  statusLine.textContent = ''
  convertButton.disabled = !file
  if (!file) return
  try {
    const probe = await probeMedia(file)
    $('sondagem').textContent =
      `${file.name}: ${mb(file.size)} · duração ${probe.durationSec?.toFixed(1) ?? '?'} s · ` +
      `saída estimada ${probe.estimatedBytes === null ? '?' : mb(probe.estimatedBytes)} · ` +
      `motor ${probe.engine}`
  } catch (error) {
    showError(error)
  }
})

convertButton.addEventListener('click', async () => {
  const file = fileInput.files?.[0]
  if (!file) return
  controller = new AbortController()
  convertButton.disabled = true
  cancelButton.disabled = false
  statusLine.className = ''
  const start = performance.now()
  try {
    const result = await convertAudio(file, {
      signal: controller.signal,
      onProgress: ({ ratio, bytesRead, bytesTotal }) => {
        progressBar.value = ratio
        statusLine.textContent = `${Math.round(ratio * 100)}% · lidos ${mb(bytesRead)} de ${mb(bytesTotal)}`
      },
    })
    const seconds = (performance.now() - start) / 1000
    statusLine.textContent = `Pronto em ${seconds.toFixed(1)} s.`
    const url = URL.createObjectURL(result.blob)
    const name = file.name.replace(/\.[^.]+$/, '') + OUTPUT_FORMAT.extension
    const link = Object.assign(document.createElement('a'), { href: url, download: name, textContent: name })
    resultList.replaceChildren(
      ...row('Motor', result.engine),
      ...row('Tamanho', `${mb(result.blob.size)} (entrada ${mb(file.size)})`),
      ...row('Duração', `${result.durationSec.toFixed(2)} s`),
      ...row('SHA-256', result.sha256),
      ...row('Baixar', link),
    )
    resultList.hidden = player.hidden = false
    player.src = url
  } catch (error) {
    showError(error)
  } finally {
    controller = null
    convertButton.disabled = false
    cancelButton.disabled = true
  }
})

cancelButton.addEventListener('click', () => controller?.abort())
