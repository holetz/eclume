import { useEffect, useRef, useState } from 'react'

/** Quantas barras o `.meter-lg` do DS mostra. */
export const BARRAS = 46

/**
 * O medidor contínuo da gravação: o nível RMS que chega no estado vira a barra mais nova, e as
 * anteriores rolam para a esquerda. Pausado, as barras ficam paradas e apagadas.
 */
export function Medidor({ nivel, pausado }: { nivel: number; pausado: boolean }) {
  const [barras, setBarras] = useState<number[]>(() => Array(BARRAS).fill(0))
  const ultimo = useRef<number | null>(null)

  useEffect(() => {
    if (pausado || ultimo.current === nivel) return
    ultimo.current = nivel
    // RMS de fala fica bem abaixo de 1: a raiz abre a escala para a barra se mexer.
    const altura = Math.min(1, Math.sqrt(nivel * 3))
    const id = requestAnimationFrame(() => setBarras((atual) => [...atual.slice(1), altura]))
    return () => cancelAnimationFrame(id)
  }, [nivel, pausado])

  return (
    <div
      className="meter meter-lg"
      aria-hidden="true"
      style={pausado ? { color: 'var(--color-divider)' } : undefined}
    >
      {barras.map((altura, i) => (
        <i key={i} style={{ ['--h' as string]: `${Math.max(4, Math.round(altura * 100))}%` }} />
      ))}
    </div>
  )
}
