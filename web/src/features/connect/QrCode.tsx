import { useEffect, useState } from 'react'
import styles from './Connect.module.css'

type Qr = { size: number; rows: string[] }

/**
 * O QR num `<svg>` desenhado aqui, preto sobre branco também no tema escuro, dentro da moldura do
 * `.qr-slot`. O pacote `qrcode` só carrega com esta peça.
 */
export function QrCode({ value, label }: { value: string; label: string }) {
  const [qr, setQr] = useState<Qr | null>(null)

  useEffect(() => {
    let active = true
    import('./qr').then(({ qrMatrix, qrRowPaths, QUIET_ZONE }) => {
      const matrix = qrMatrix(value)
      if (active) setQr({ size: matrix.size + 2 * QUIET_ZONE, rows: qrRowPaths(matrix) })
    })
    return () => {
      active = false
    }
  }, [value])

  return (
    <div className={`qr-slot ${styles.qr}`}>
      {qr ? (
        <svg
          role="img"
          aria-label={label}
          viewBox={`0 0 ${qr.size} ${qr.size}`}
          width={200}
          height={200}
          shapeRendering="crispEdges"
        >
          <rect width={qr.size} height={qr.size} fill="#fff" />
          {qr.rows.map((d, i) => (
            <path key={i} d={d} fill="#000" />
          ))}
        </svg>
      ) : (
        <span role="status">Gerando o código…</span>
      )}
    </div>
  )
}
