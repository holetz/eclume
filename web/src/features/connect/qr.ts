import QRCode from 'qrcode'

interface QrMatrix {
  size: number
  dark(x: number, y: number): boolean
}

/** The QR module matrix (error correction M) from the `qrcode` package, without drawing anything. */
export function qrMatrix(text: string): QrMatrix {
  const { size, data } = QRCode.create(text, { errorCorrectionLevel: 'M' }).modules
  return { size, dark: (x, y) => data[y * size + x] === 1 }
}

/** The quiet zone the reader needs around the symbol, in modules. */
export const QUIET_ZONE = 4

/** One SVG path per row of modules: each dark run becomes a rectangle of height 1. */
export function qrRowPaths(matrix: QrMatrix): string[] {
  const rows: string[] = []
  for (let y = 0; y < matrix.size; y++) {
    let d = ''
    let x = 0
    while (x < matrix.size) {
      if (!matrix.dark(x, y)) {
        x++
        continue
      }
      const start = x
      while (x < matrix.size && matrix.dark(x, y)) x++
      d += `M${start + QUIET_ZONE} ${y + QUIET_ZONE}h${x - start}v1h-${x - start}z`
    }
    if (d) rows.push(d)
  }
  return rows
}
