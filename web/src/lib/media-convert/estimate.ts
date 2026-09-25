/** O formato de saída, fixo: Opus mono 16 kHz em Ogg. */
export const OUTPUT_FORMAT = {
  codec: 'opus',
  container: 'ogg',
  channels: 1,
  sampleRate: 16_000,
  mimeType: 'audio/ogg; codecs=opus',
  extension: '.ogg',
} as const

export const DEFAULT_BITRATE = 32_000
export const MIN_BITRATE = 16_000
export const MAX_BITRATE = 64_000

// Sobrecarga do Ogg por segundo: um byte de lacing por pacote Opus de 20 ms (50/s) e o
// cabeçalho de 27 bytes de ~1 página por segundo. Os cabeçalhos OpusHead/OpusTags ficam na
// constante fixa.
const OGG_OVERHEAD_BYTES_PER_SECOND = 80
const OGG_FIXED_HEADER_BYTES = 1024

export function normalizeBitrate(bitrate: number = DEFAULT_BITRATE): number {
  if (!Number.isFinite(bitrate) || bitrate < MIN_BITRATE || bitrate > MAX_BITRATE) {
    throw new RangeError(`bitrate deve estar entre ${MIN_BITRATE} e ${MAX_BITRATE} bits/s`)
  }
  return Math.round(bitrate)
}

/** Tamanho aproximado, em bytes, do arquivo Opus/Ogg para uma duração em segundos. */
export function estimateOutputSize(durationSec: number, bitrate: number = DEFAULT_BITRATE): number {
  if (!Number.isFinite(durationSec) || durationSec < 0) {
    throw new RangeError('durationSec deve ser um número finito e não negativo')
  }
  const perSecond = normalizeBitrate(bitrate) / 8 + OGG_OVERHEAD_BYTES_PER_SECOND
  return Math.ceil(durationSec * perSecond + OGG_FIXED_HEADER_BYTES)
}
