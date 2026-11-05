import { useEffect, useRef, useState } from 'react'

/** How many bars the DS's `.meter-lg` shows. */
export const BARS = 46

/**
 * The recording's continuous meter: the RMS level that arrives in the state becomes the newest bar,
 * and the older ones scroll left. Paused, the bars stand still and dimmed.
 */
export function Meter({ level, paused }: { level: number; paused: boolean }) {
  const [bars, setBars] = useState<number[]>(() => Array(BARS).fill(0))
  const last = useRef<number | null>(null)

  useEffect(() => {
    if (paused || last.current === level) return
    last.current = level
    // Speech RMS stays well below 1: the square root opens the scale so the bar moves.
    const height = Math.min(1, Math.sqrt(level * 3))
    const id = requestAnimationFrame(() => setBars((current) => [...current.slice(1), height]))
    return () => cancelAnimationFrame(id)
  }, [level, paused])

  return (
    <div
      className={paused ? 'meter meter-lg meter-paused' : 'meter meter-lg'}
      aria-hidden="true"
    >
      {bars.map((height, i) => (
        <i key={i} style={{ ['--h' as string]: `${Math.max(4, Math.round(height * 100))}%` }} />
      ))}
    </div>
  )
}
