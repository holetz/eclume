import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPlaybackClock, PlaybackContext, RATES, type Playback, type PlaybackError } from './playback'

interface PlaybackProviderProps {
  recordingId: string
  /** Duração conhecida da gravação, até o áudio carregar os metadados. */
  durationMs: number | null
  /** Instante inicial (`?t=`), sem tocar. */
  startMs?: number | null
  /** O áudio já foi apagado pela retenção: não há `<audio>` nem pedido à rota, que responde 410. */
  audioDeleted?: boolean
  children: ReactNode
}

const OPUS = 'audio/ogg; codecs=opus'

/**
 * Guarda o `<audio>` único da gravação e expõe tempo, estado e comandos pelo contexto. O `src` é a
 * rota da API, que responde 302 para uma URL assinada de 1 h: quando ela vence no meio da escuta, o
 * erro do `<audio>` pede uma assinatura nova (outro `src`) e retoma do mesmo instante, tocando se
 * tocava, uma vez sozinho; se falhar de novo, o erro vai para o player.
 */
export function PlaybackProvider({ recordingId, durationMs, startMs = null, audioDeleted = false, children }: PlaybackProviderProps) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [clock] = useState(() => createPlaybackClock(startMs ?? 0))
  const [loadedMs, setLoadedMs] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [rate, setRate] = useState<number>(1)
  const [error, setError] = useState<PlaybackError | null>(null)
  const [renewal, setRenewal] = useState(0)
  const src = `/api/v1/recordings/${recordingId}/audio${renewal ? `?renovacao=${renewal}` : ''}`
  // Se a pessoa queria ouvir (tocou e não pausou), para retomar tocando depois da renovação.
  const wantsPlay = useRef(false)
  const loaded = useRef(false)
  const renewed = useRef(false)
  const resumeAt = useRef<number | null>(null)

  useEffect(() => {
    // Sem mídia carregada, o navegador guarda o instante como posição inicial da reprodução.
    if (startMs !== null && audioRef.current) audioRef.current.currentTime = startMs / 1000
  }, [startMs])

  const seek = useCallback((ms: number, play = false) => {
    const audio = audioRef.current
    // O player mostra o instante buscado antes de o áudio carregar.
    clock.set(ms)
    if (!audio) return
    audio.currentTime = ms / 1000
    if (play) {
      wantsPlay.current = true
      audio.play().catch(() => {})
    }
  }, [clock])

  const toggle = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    wantsPlay.current = audio.paused
    if (audio.paused) audio.play().catch(() => {})
    else audio.pause()
  }, [])

  const renew = useCallback(() => {
    const audio = audioRef.current
    resumeAt.current = audio ? audio.currentTime * 1000 : null
    setRenewal((count) => count + 1)
  }, [])

  const retry = useCallback(() => {
    setError(null)
    renewed.current = true
    renew()
  }, [renew])

  function handleError(audio: HTMLAudioElement) {
    // Nunca carregou e o navegador diz que não toca Ogg Opus: renovar não resolve.
    if (!loaded.current && audio.canPlayType(OPUS) === '') {
      setError('format')
      return
    }
    if (renewed.current) {
      setError('network')
      setPlaying(false)
      return
    }
    renewed.current = true
    renew()
  }

  const cycleRate = useCallback(() => {
    setRate((current) => {
      const next = RATES[(RATES.indexOf(current as (typeof RATES)[number]) + 1) % RATES.length]
      if (audioRef.current) audioRef.current.playbackRate = next
      return next
    })
  }, [])

  const value = useMemo<Playback>(
    () => ({
      clock,
      durationMs: loadedMs ?? durationMs ?? 0,
      playing,
      rate,
      seek,
      toggle,
      cycleRate,
      error,
      retry,
    }),
    [clock, loadedMs, durationMs, playing, rate, seek, toggle, cycleRate, error, retry],
  )

  return (
    <PlaybackContext.Provider value={value}>
      {!audioDeleted && (
        <audio
          ref={audioRef}
          preload="metadata"
          src={src}
          aria-label="Áudio da gravação"
          onTimeUpdate={(event) => clock.set(event.currentTarget.currentTime * 1000)}
          onPlay={() => setPlaying(true)}
          onPlaying={() => {
            // Tocou de novo: uma próxima expiração tem direito à sua renovação automática.
            renewed.current = false
          }}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            wantsPlay.current = false
            setPlaying(false)
          }}
          onError={(event) => handleError(event.currentTarget)}
          onLoadedMetadata={(event) => {
            const audio = event.currentTarget
            loaded.current = true
            const seconds = audio.duration
            if (Number.isFinite(seconds) && seconds > 0) setLoadedMs(seconds * 1000)
            if (resumeAt.current !== null) {
              audio.currentTime = resumeAt.current / 1000
              audio.playbackRate = rate
              resumeAt.current = null
              if (wantsPlay.current) audio.play().catch(() => {})
            }
          }}
        />
      )}
      {children}
    </PlaybackContext.Provider>
  )
}
