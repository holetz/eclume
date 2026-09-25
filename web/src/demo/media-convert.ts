// Demonstração manual da biblioteca de conversão (só no `npm run dev`, em /media-convert.html).
import {
  checkEnvironment,
  convertAudio,
  MediaConvertError,
  OUTPUT_FORMAT,
  probeMedia,
} from '../lib/media-convert'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const arquivo = $<HTMLInputElement>('arquivo')
const converter = $<HTMLButtonElement>('converter')
const cancelar = $<HTMLButtonElement>('cancelar')
const progresso = $<HTMLProgressElement>('progresso')
const estado = $('estado')
const resultado = $('resultado')
const ouvir = $<HTMLAudioElement>('ouvir')

const mb = (bytes: number) => `${(bytes / 1_000_000).toFixed(2)} MB`

const env = checkEnvironment()
$('ambiente').textContent =
  `Contexto seguro: ${env.secureContext ? 'sim' : 'não (a conversão exige HTTPS)'} · ` +
  `WebCodecs: ${env.webCodecs ? 'sim' : 'não (usará ffmpeg.wasm)'}`

let controller: AbortController | null = null

function linha(termo: string, valor: string | Node): [HTMLElement, HTMLElement] {
  const dd = document.createElement('dd')
  dd.append(valor)
  return [Object.assign(document.createElement('dt'), { textContent: termo }), dd]
}

function mostrarErro(error: unknown) {
  estado.className = 'erro'
  estado.textContent =
    error instanceof MediaConvertError ? `${error.message} (${error.code})` : String(error)
}

arquivo.addEventListener('change', async () => {
  const file = arquivo.files?.[0]
  resultado.hidden = ouvir.hidden = true
  estado.textContent = ''
  converter.disabled = !file
  if (!file) return
  try {
    const probe = await probeMedia(file)
    $('sondagem').textContent =
      `${file.name}: ${mb(file.size)} · duração ${probe.durationSec?.toFixed(1) ?? '?'} s · ` +
      `saída estimada ${probe.estimatedBytes === null ? '?' : mb(probe.estimatedBytes)} · ` +
      `motor ${probe.engine}`
  } catch (error) {
    mostrarErro(error)
  }
})

converter.addEventListener('click', async () => {
  const file = arquivo.files?.[0]
  if (!file) return
  controller = new AbortController()
  converter.disabled = true
  cancelar.disabled = false
  estado.className = ''
  const inicio = performance.now()
  try {
    const result = await convertAudio(file, {
      signal: controller.signal,
      onProgress: ({ ratio, bytesRead, bytesTotal }) => {
        progresso.value = ratio
        estado.textContent = `${Math.round(ratio * 100)}% · lidos ${mb(bytesRead)} de ${mb(bytesTotal)}`
      },
    })
    const segundos = (performance.now() - inicio) / 1000
    estado.textContent = `Pronto em ${segundos.toFixed(1)} s.`
    const url = URL.createObjectURL(result.blob)
    const nome = file.name.replace(/\.[^.]+$/, '') + OUTPUT_FORMAT.extension
    const link = Object.assign(document.createElement('a'), { href: url, download: nome, textContent: nome })
    resultado.replaceChildren(
      ...linha('Motor', result.engine),
      ...linha('Tamanho', `${mb(result.blob.size)} (entrada ${mb(file.size)})`),
      ...linha('Duração', `${result.durationSec.toFixed(2)} s`),
      ...linha('SHA-256', result.sha256),
      ...linha('Baixar', link),
    )
    resultado.hidden = ouvir.hidden = false
    ouvir.src = url
  } catch (error) {
    mostrarErro(error)
  } finally {
    controller = null
    converter.disabled = false
    cancelar.disabled = true
  }
})

cancelar.addEventListener('click', () => controller?.abort())
