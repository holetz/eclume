// ffmpeg.wasm fallback. Reached only through a dynamic import(): the core (~30 MB of wasm)
// lives in a separate chunk and is downloaded only when WebCodecs does not work.
import { FFFSType, FFmpeg, type LogEvent, type ProgressEvent } from '@ffmpeg/ffmpeg'
import coreURL from '@ffmpeg/core?url'
import wasmURL from '@ffmpeg/core/wasm?url'
import type { EngineRequest } from './engine'
import { MediaConvertError, throwIfAborted, toMediaConvertError } from './errors'
import { OUTPUT_FORMAT } from './estimate'

const INPUT_DIR = '/entrada'
const INPUT_PATH = `${INPUT_DIR}/arquivo`
const OUTPUT_PATH = '/saida.ogg'
const LOG_TAIL = 30

export async function convertWithFfmpeg({
  file,
  bitrate,
  signal,
  progress,
}: EngineRequest): Promise<Blob> {
  throwIfAborted(signal)
  const ffmpeg = new FFmpeg()
  const logs: string[] = []
  const onLog = ({ message }: LogEvent) => {
    logs.push(message)
    if (logs.length > LOG_TAIL) logs.shift()
  }
  // WORKERFS does not expose the reads: the bytes are estimated from the ratio.
  const onProgress = ({ progress: ratio }: ProgressEvent) =>
    progress.setRatio(ratio, Math.round(ratio * file.size))
  const terminate = () => ffmpeg.terminate()
  ffmpeg.on('log', onLog)
  ffmpeg.on('progress', onProgress)
  signal?.addEventListener('abort', terminate, { once: true })
  try {
    await ffmpeg.load({ coreURL, wasmURL })
    await ffmpeg.createDir(INPUT_DIR)
    // WORKERFS reads the Blob on demand, without copying it into the wasm memory.
    await ffmpeg.mount(FFFSType.WORKERFS, { blobs: [{ name: 'arquivo', data: file }] }, INPUT_DIR)
    const code = await ffmpeg.exec([
      '-hide_banner',
      '-nostdin',
      '-i', INPUT_PATH,
      '-map', '0:a:0',
      '-vn', '-sn', '-dn',
      '-ac', String(OUTPUT_FORMAT.channels),
      '-ar', String(OUTPUT_FORMAT.sampleRate),
      '-c:a', 'libopus',
      '-b:a', String(bitrate),
      '-map_metadata', '-1',
      '-f', 'ogg',
      OUTPUT_PATH,
    ])
    if (code !== 0) {
      const tail = logs.join('\n')
      if (/matches no streams|does not contain any stream/.test(tail)) {
        throw new MediaConvertError('no-audio', undefined, { cause: tail })
      }
      if (/Invalid data found|Unknown format|could not find codec/i.test(tail)) {
        throw new MediaConvertError('unsupported', undefined, { cause: tail })
      }
      throw new MediaConvertError('failed', undefined, { cause: tail })
    }
    const data = (await ffmpeg.readFile(OUTPUT_PATH)) as Uint8Array<ArrayBuffer>
    return new Blob([data], { type: OUTPUT_FORMAT.mimeType })
  } catch (error) {
    throw toMediaConvertError(error, signal)
  } finally {
    signal?.removeEventListener('abort', terminate)
    ffmpeg.off('log', onLog)
    ffmpeg.off('progress', onProgress)
    ffmpeg.terminate()
  }
}
