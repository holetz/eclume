/** The fixed output format: mono 16 kHz Opus in Ogg. */
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

// Ogg overhead per second: one lacing byte per 20 ms Opus packet (50/s) and the
// 27-byte header of ~1 page per second. The OpusHead/OpusTags headers go in the
// fixed constant.
const OGG_OVERHEAD_BYTES_PER_SECOND = 80
const OGG_FIXED_HEADER_BYTES = 1024

export function normalizeBitrate(bitrate: number = DEFAULT_BITRATE): number {
  if (!Number.isFinite(bitrate) || bitrate < MIN_BITRATE || bitrate > MAX_BITRATE) {
    throw new RangeError(`bitrate must be between ${MIN_BITRATE} and ${MAX_BITRATE} bits/s`)
  }
  return Math.round(bitrate)
}

/** Approximate size, in bytes, of the Opus/Ogg file for a duration in seconds. */
export function estimateOutputSize(durationSec: number, bitrate: number = DEFAULT_BITRATE): number {
  if (!Number.isFinite(durationSec) || durationSec < 0) {
    throw new RangeError('durationSec must be a finite, non-negative number')
  }
  const perSecond = normalizeBitrate(bitrate) / 8 + OGG_OVERHEAD_BYTES_PER_SECOND
  return Math.ceil(durationSec * perSecond + OGG_FIXED_HEADER_BYTES)
}
