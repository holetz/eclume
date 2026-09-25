// Fluxo do import: escolher o arquivo → estimar → converter no navegador → enviar em partes.
// O áudio convertido fica em memória enquanto a página está aberta, para pausar e retomar o envio.
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { errorMessage } from '../../api/problem'
import { convertAudio, MediaConvertError, OUTPUT_FORMAT, probeMedia, type MediaProbe } from '../../lib/media-convert'
import { cancelUpload, runUpload, UploadError, type UploadProgress } from '../../upload/multipart'

export type ImportState =
  | { step: 'idle' }
  | { step: 'selected'; file: File; probe: MediaProbe | null; probing: boolean }
  | { step: 'converting'; file: File; ratio: number }
  | { step: 'uploading'; file: File; progress: UploadProgress | null }
  | { step: 'paused'; file: File; progress: UploadProgress | null }
  | { step: 'done'; file: File; recordingId: string; deduplicated: boolean }
  | { step: 'error'; file: File; message: string; resumable: boolean }

interface Converted {
  blob: Blob
  sha256: string
  durationSec: number
}

/** Nome do arquivo sem a extensão, para título e nome do Opus. */
export function fileStem(name: string): string {
  const dot = name.lastIndexOf('.')
  return (dot > 0 ? name.slice(0, dot) : name).trim() || 'gravação'
}

function describe(error: unknown): string {
  if (error instanceof MediaConvertError || error instanceof UploadError) return error.message
  return errorMessage(error)
}

export function useImport() {
  const queryClient = useQueryClient()
  const [state, setState] = useState<ImportState>({ step: 'idle' })
  const controller = useRef<AbortController | null>(null)
  const converted = useRef<Converted | null>(null)
  const uploadId = useRef<string | null>(null)
  const title = useRef('')
  const lastProgress = useRef<UploadProgress | null>(null)
  const stopReason = useRef<'pause' | 'cancel' | null>(null)
  const probed = useRef<MediaProbe | null>(null)

  useEffect(() => () => controller.current?.abort(), [])

  const select = useCallback((file: File) => {
    controller.current?.abort()
    converted.current = null
    uploadId.current = null
    probed.current = null
    setState({ step: 'selected', file, probe: null, probing: true })
    probeMedia(file)
      .then((probe) => {
        probed.current = probe
        setState((s) => (s.step === 'selected' && s.file === file ? { ...s, probe, probing: false } : s))
      })
      .catch(() => setState((s) => (s.step === 'selected' && s.file === file ? { ...s, probing: false } : s)))
  }, [])

  const upload = useCallback(
    async (file: File) => {
      const audio = converted.current!
      const abort = new AbortController()
      controller.current = abort
      stopReason.current = null
      setState({ step: 'uploading', file, progress: lastProgress.current })
      try {
        const outcome = await runUpload(
          {
            blob: audio.blob,
            sha256: audio.sha256,
            filename: `${fileStem(file.name)}${OUTPUT_FORMAT.extension}`,
            contentType: OUTPUT_FORMAT.mimeType,
            title: title.current,
            durationMs: audio.durationSec * 1000,
          },
          {
            uploadId: uploadId.current ?? undefined,
            signal: abort.signal,
            onCreated: (id) => {
              uploadId.current = id
            },
            onProgress: (progress) => {
              lastProgress.current = progress
              setState((s) => (s.step === 'uploading' ? { ...s, progress } : s))
            },
          },
        )
        converted.current = null
        uploadId.current = null
        void queryClient.invalidateQueries({ queryKey: ['recordings'] })
        setState({ step: 'done', file, ...outcome })
      } catch (error) {
        if (stopReason.current === 'pause') {
          setState({ step: 'paused', file, progress: lastProgress.current })
        } else if (stopReason.current !== 'cancel') {
          // Upload expirado ou abortado no servidor: a próxima tentativa começa outro.
          if (error instanceof UploadError && error.code === 'upload_gone') uploadId.current = null
          setState({ step: 'error', file, message: describe(error), resumable: uploadId.current !== null })
        }
      }
    },
    [queryClient],
  )

  const start = useCallback(
    async (file: File, chosenTitle: string) => {
      title.current = chosenTitle.trim() || fileStem(file.name)
      lastProgress.current = null
      const abort = new AbortController()
      controller.current = abort
      stopReason.current = null
      setState({ step: 'converting', file, ratio: 0 })
      try {
        converted.current = await convertAudio(file, {
          signal: abort.signal,
          onProgress: ({ ratio }) => setState((s) => (s.step === 'converting' ? { ...s, ratio } : s)),
        })
      } catch (error) {
        if (stopReason.current !== 'cancel') {
          setState({ step: 'error', file, message: describe(error), resumable: false })
        }
        return
      }
      await upload(file)
    },
    [upload],
  )

  const pause = useCallback(() => {
    stopReason.current = 'pause'
    controller.current?.abort(new DOMException('Envio pausado.', 'AbortError'))
  }, [])

  /** Retoma o envio pausado ou que falhou; sem áudio convertido, recomeça pela conversão. */
  const resume = useCallback(() => {
    if (state.step !== 'paused' && state.step !== 'error') return
    if (converted.current) void upload(state.file)
    else void start(state.file, title.current)
  }, [state, start, upload])

  const cancel = useCallback(() => {
    if (!('file' in state)) return
    stopReason.current = 'cancel'
    controller.current?.abort(new DOMException('Import cancelado.', 'AbortError'))
    const id = uploadId.current
    uploadId.current = null
    converted.current = null
    if (id) void cancelUpload(id).catch(() => {})
    setState({ step: 'selected', file: state.file, probe: probed.current, probing: false })
  }, [state])

  const reset = useCallback(() => {
    controller.current?.abort()
    converted.current = null
    uploadId.current = null
    setState({ step: 'idle' })
  }, [])

  return { state, select, start, pause, resume, cancel, reset }
}
