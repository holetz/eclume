import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { i18n } from '../../i18n'
import { createPlaybackClock, PlaybackContext, RATES, type Playback, type PlaybackError } from './playback'

interface PlaybackProviderProps {
  recordingId: string
  /** The recording's known duration, until the audio loads its metadata. */
  durationMs: number | null
  /** Initial instant (`?t=`), without playing. */
  startMs?: number | null
  /** The audio has already been deleted by retention: there is no `<audio>` nor a request to the route, which answers 410. */
  audioDeleted?: boolean
  children: ReactNode
}

const OPUS = 'audio/ogg; codecs=opus'

/**
 * Holds the recording's single `<audio>` and exposes time, state and commands through the context. The `src` is the
 * API route, which answers 302 to a signed URL valid for 1 h: when it expires mid-listening, the
 * `<audio>` error asks for a new signature (another `src`) and resumes from the same instant, playing if it
 * was playing, once on its own; if it fails again, the error goes to the player.
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
  // Whether the person wanted to listen (played and did not pause), to resume playing after the renewal.
  const wantsPlay = useRef(false)
  const loaded = useRef(false)
  const renewed = useRef(false)
  const resumeAt = useRef<number | null>(null)

  useEffect(() => {
    // With no media loaded, the browser keeps the instant as the playback's starting position.
    if (startMs !== null && audioRef.current) audioRef.current.currentTime = startMs / 1000
  }, [startMs])

  const seek = useCallback((ms: number, play = false) => {
    const audio = audioRef.current
    // The player shows the sought instant before the audio loads.
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
    // Never loaded and the browser says it does not play Ogg Opus: renewing does not help.
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
          aria-label={i18n.t('transcript:audio')}
          onTimeUpdate={(event) => clock.set(event.currentTarget.currentTime * 1000)}
          onPlay={() => setPlaying(true)}
          onPlaying={() => {
            // Played again: a next expiry is entitled to its own automatic renewal.
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
