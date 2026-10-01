// A reprodução compartilhada da página da gravação: um único <audio>, lido e comandado pelo player,
// pelos ticks e fichas dos marcadores e pelas falas da transcrição.
import { createContext, useContext, useSyncExternalStore } from 'react'

export const RATES = [1, 1.25, 1.5, 2] as const

/**
 * O instante do áudio, fora do contexto: muda 4×/s no `timeupdate`, e só quem o lê pela store
 * (`usePlaybackTime`, `usePlaybackSelect`) renderiza por tick.
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

/** Estado e comandos da reprodução; muda só quando duração, tocando, velocidade ou erro mudam. */
export interface Playback {
  clock: PlaybackClock
  durationMs: number
  playing: boolean
  rate: number
  /** Posiciona o áudio; com `play`, toca dali (o navegador pode recusar o play, e a posição vale). */
  seek: (ms: number, play?: boolean) => void
  toggle: () => void
  /** Passa para a próxima velocidade: 1×, 1,25×, 1,5× e 2×. */
  cycleRate: () => void
  /**
   * O áudio que não carregou depois da renovação automática (`network`), ou o navegador que não toca
   * Ogg Opus (`format`); `null` com o áudio em ordem.
   */
  error: PlaybackError | null
  /** Pede uma assinatura nova e retoma do mesmo instante. */
  retry: () => void
}

export type PlaybackError = 'network' | 'format'

export const PlaybackContext = createContext<Playback | null>(null)

export function usePlayback(): Playback {
  const playback = useContext(PlaybackContext)
  if (!playback) throw new Error('usePlayback fora do PlaybackProvider')
  return playback
}

/** O instante do áudio em ms: renderiza a cada tick. */
export function usePlaybackTime(): number {
  const { clock } = usePlayback()
  return useSyncExternalStore(clock.subscribe, clock.get)
}

/**
 * Um valor derivado do instante (a fala ativa, por exemplo): renderiza só quando ele muda. O
 * seletor devolve um valor primitivo, comparado por `Object.is`.
 */
export function usePlaybackSelect<T extends string | number | boolean | null>(select: (ms: number) => T): T {
  const { clock } = usePlayback()
  return useSyncExternalStore(clock.subscribe, () => select(clock.get()))
}

/** "1×", "1,25×". */
export function rateLabel(rate: number): string {
  return `${rate.toLocaleString('pt-BR')}×`
}
