// The recording page's shared playback: a single <audio>, read and commanded by the player,
// by the markers' ticks and chips and by the transcript's segments.
import { createContext, useContext, useSyncExternalStore } from 'react'

export const RATES = [1, 1.25, 1.5, 2] as const

/**
 * The audio's instant, outside the context: it changes 4×/s on `timeupdate`, and only those who read it through the store
 * (`usePlaybackTime`, `usePlaybackSelect`) render per tick.
 */
export interface PlaybackClock {
  get: () => number
  set: (ms: number) => void
  subscribe: (listener: () => void) => () => void
}

export function createPlaybackClock(initialMs: number): PlaybackClock {
  let current = initialMs
  const listeners = new Set<() => void>()
  return {
    get: () => current,
    set: (ms) => {
      if (ms === current) return
      current = ms
      for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/** Playback state and commands; changes only when duration, playing, speed or error change. */
export interface Playback {
  clock: PlaybackClock
  durationMs: number
  playing: boolean
  rate: number
  /** Seeks the audio; with `play`, plays from there (the browser may refuse the play, and the position holds). */
  seek: (ms: number, play?: boolean) => void
  toggle: () => void
  /** Moves to the next speed: 1×, 1,25×, 1,5× and 2×. */
  cycleRate: () => void
  /**
   * The audio that did not load after the automatic renewal (`network`), or the browser that does not play
   * Ogg Opus (`format`); `null` with the audio in order.
   */
  error: PlaybackError | null
  /** Asks for a new signature and resumes from the same instant. */
  retry: () => void
}

export type PlaybackError = 'network' | 'format'

export const PlaybackContext = createContext<Playback | null>(null)

export function usePlayback(): Playback {
  const playback = useContext(PlaybackContext)
  if (!playback) throw new Error('usePlayback fora do PlaybackProvider')
  return playback
}

/** The audio's instant in ms: renders on every tick. */
export function usePlaybackTime(): number {
  const { clock } = usePlayback()
  return useSyncExternalStore(clock.subscribe, clock.get)
}

/**
 * A value derived from the instant (the active segment, for example): renders only when it changes. The
 * selector returns a primitive value, compared with `Object.is`.
 */
export function usePlaybackSelect<T extends string | number | boolean | null>(select: (ms: number) => T): T {
  const { clock } = usePlayback()
  return useSyncExternalStore(clock.subscribe, () => select(clock.get()))
}

/** "1×", "1,25×". */
export function rateLabel(rate: number): string {
  return `${rate.toLocaleString('pt-BR')}×`
}
