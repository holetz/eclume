import QRCode from 'qrcode'

interface QrMatrix {
  size: number
  dark(x: number, y: number): boolean
}

/** A matriz de módulos do QR (correção de erro M) do pacote `qrcode`, sem desenhar nada. */
export function qrMatrix(text: string): QrMatrix {
  const { size, data } = QRCode.create(text, { errorCorrectionLevel: 'M' }).modules
  return { size, dark: (x, y) => data[y * size + x] === 1 }
}

/** A zona de silêncio que o leitor precisa em volta do símbolo, em módulos. */
export const QUIET_ZONE = 4

/** Um caminho SVG por linha de módulos: cada trecho escuro vira um retângulo de altura 1. */
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
