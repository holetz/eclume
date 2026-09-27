import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { PlaybackContext, RATES, type Playback } from './playback'

interface PlaybackProviderProps {
  recordingId: string
  /** Duração conhecida da gravação, até o áudio carregar os metadados. */
  durationMs: number | null
  /** Instante inicial (`?t=`), sem tocar. */
  startMs?: number | null
  children: ReactNode
}

/** Guarda o `<audio>` único da gravação e expõe tempo, estado e comandos pelo contexto. */
export function PlaybackProvider({ recordingId, durationMs, startMs = null, children }: PlaybackProviderProps) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [currentMs, setCurrentMs] = useState(startMs ?? 0)
  const [loadedMs, setLoadedMs] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [rate, setRate] = useState<number>(1)

  useEffect(() => {
    // Sem mídia carregada, o navegador guarda o instante como posição inicial da reprodução.
    if (startMs !== null && audioRef.current) audioRef.current.currentTime = startMs / 1000
  }, [startMs])

  const seek = useCallback((ms: number, play = false) => {
    const audio = audioRef.current
    setCurrentMs(ms)
    if (!audio) return
    audio.currentTime = ms / 1000
    if (play) audio.play().catch(() => {})
  }, [])

  const toggle = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    if (audio.paused) audio.play().catch(() => {})
    else audio.pause()
  }, [])

  const cycleRate = useCallback(() => {
    setRate((current) => {
      const next = RATES[(RATES.indexOf(current as (typeof RATES)[number]) + 1) % RATES.length]
      if (audioRef.current) audioRef.current.playbackRate = next
      return next
    })
  }, [])

  const value = useMemo<Playback>(
    () => ({ currentMs, durationMs: loadedMs ?? durationMs ?? 0, playing, rate, seek, toggle, cycleRate }),
    [currentMs, loadedMs, durationMs, playing, rate, seek, toggle, cycleRate],
  )

  return (
    <PlaybackContext.Provider value={value}>
      <audio
        ref={audioRef}
        preload="metadata"
        src={`/api/v1/recordings/${recordingId}/audio`}
        aria-label="Áudio da gravação"
        onTimeUpdate={(event) => setCurrentMs(event.currentTarget.currentTime * 1000)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onLoadedMetadata={(event) => {
          const seconds = event.currentTarget.duration
          if (Number.isFinite(seconds) && seconds > 0) setLoadedMs(seconds * 1000)
        }}
      />
      {children}
    </PlaybackContext.Provider>
  )
}
