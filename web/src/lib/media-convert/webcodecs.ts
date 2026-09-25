import {
  ALL_FORMATS,
  BufferSource,
  Conversion,
  CustomSource,
  Input,
  OggOutputFormat,
  Output,
  Quality,
  StreamTarget,
  type StreamTargetChunk,
} from 'mediabunny'
import type { EngineRequest, ProbeResult } from './engine'
import { MediaConvertError, throwIfAborted, toMediaConvertError } from './errors'
import { OUTPUT_FORMAT } from './estimate'
import type { ProgressTracker } from './progress'

/** Lê o arquivo em fatias, sob demanda: um vídeo de vários GB nunca entra inteiro na memória. */
function sliceSource(file: Blob, progress?: ProgressTracker): CustomSource {
  return new CustomSource({
    getSize: () => file.size,
    read: async (start, end) => {
      const bytes = new Uint8Array(await file.slice(start, end).arrayBuffer())
      progress?.addBytesRead(bytes.byteLength)
      return bytes
    },
    prefetchProfile: 'fileSystem',
  })
}

async function openAudio(file: Blob, progress?: ProgressTracker) {
  const input = new Input({ formats: ALL_FORMATS, source: sliceSource(file, progress) })
  if (!(await input.canRead())) {
    input.dispose()
    throw new MediaConvertError('unsupported')
  }
  return { input, track: await input.getPrimaryAudioTrack() }
}

export async function probeWithWebCodecs(file: Blob): Promise<ProbeResult> {
  const { input, track } = await openAudio(file)
  try {
    return {
      durationSec: await input.getDurationFromMetadata(track ? [track] : undefined),
      hasAudio: track !== null,
    }
  } finally {
    input.dispose()
  }
}

/** Opus mono 16 kHz em Ogg pelo WebCodecs. Falha com `unsupported` quando não dá para decodificar ou codificar. */
export async function convertWithWebCodecs({
  file,
  bitrate,
  signal,
  progress,
}: EngineRequest): Promise<Blob> {
  throwIfAborted(signal)
  const { input, track } = await openAudio(file, progress)
  try {
    if (!track) throw new MediaConvertError('no-audio')

    // O Ogg do Mediabunny é append-only: os chunks chegam em ordem e viram o Blob final.
    const parts: Uint8Array<ArrayBuffer>[] = []
    let written = 0
    const target = new StreamTarget(
      new WritableStream<StreamTargetChunk>({
        write(chunk) {
          if (chunk.position !== written) {
            throw new MediaConvertError('failed', 'Escrita fora de ordem na saída Ogg.')
          }
          parts.push(chunk.data.slice())
          written += chunk.data.byteLength
        },
      }),
    )
    const output = new Output({ format: new OggOutputFormat(), target })

    const conversion = await Conversion.init({
      input,
      output,
      tracks: 'primary',
      video: { discard: true },
      audio: {
        codec: OUTPUT_FORMAT.codec,
        numberOfChannels: OUTPUT_FORMAT.channels,
        sampleRate: OUTPUT_FORMAT.sampleRate,
        quality: new Quality(bitrate),
        forceTranscode: true,
      },
      tags: {},
      showWarnings: false,
    })
    if (!conversion.isValid) {
      throw new MediaConvertError('unsupported', undefined, {
        cause: conversion.discardedTracks.map(({ reason }) => reason),
      })
    }

    conversion.onProgress = (ratio) => progress.setRatio(ratio)
    const cancel = () => void conversion.cancel()
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      throwIfAborted(signal)
      await conversion.execute()
    } finally {
      signal?.removeEventListener('abort', cancel)
    }
    return new Blob(parts, { type: OUTPUT_FORMAT.mimeType })
  } catch (error) {
    throw toMediaConvertError(error, signal)
  } finally {
    input.dispose()
  }
}

/** Duração, em segundos, de um Ogg/Opus já convertido (relida do próprio arquivo). */
export async function measureOutputDuration(blob: Blob): Promise<number> {
  const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(await blob.arrayBuffer()) })
  try {
    return await input.computeDuration()
  } finally {
    input.dispose()
  }
}
