// A reprodução compartilhada da página da gravação: um único <audio>, lido e comandado pelo player,
// pelos ticks e fichas dos marcadores e pelas falas da transcrição.
import { createContext, useContext } from 'react'

export const RATES = [1, 1.25, 1.5, 2] as const

export interface Playback {
  currentMs: number
  durationMs: number
  playing: boolean
  rate: number
  /** Posiciona o áudio; com `play`, toca dali (o navegador pode recusar o play, e a posição vale). */
  seek: (ms: number, play?: boolean) => void
  toggle: () => void
  /** Passa para a próxima velocidade: 1×, 1,25×, 1,5× e 2×. */
  cycleRate: () => void
}

export const PlaybackContext = createContext<Playback | null>(null)

export function usePlayback(): Playback {
  const playback = useContext(PlaybackContext)
  if (!playback) throw new Error('usePlayback fora do PlaybackProvider')
  return playback
}

/** "1×", "1,25×". */
export function rateLabel(rate: number): string {
  return `${rate.toLocaleString('pt-BR')}×`
}
