import jsQR from 'jsqr'
import { describe, expect, it } from 'vitest'
import { qrMatrix, qrRowPaths, QUIET_ZONE } from './qr'

const PAIR_URL =
  'https://192.168.15.199:8443/parear?codigo=K7Q4MX&ca=3f9a1c6e0b7d24f58e1a9c3b6d0f2e4a7c5b8d1e3f6a9c2b4d7e0f1a3c5e7b9d'

/** Rasteriza os caminhos do SVG (só retângulos `M x y h n v1 h-n z`) em RGBA, como o navegador faria. */
function rasterize(rows: string[], size: number, scale = 4) {
  const width = size * scale
  const pixels = new Uint8ClampedArray(width * width * 4).fill(255)
  for (const d of rows) {
    for (const [, x, y, n] of d.matchAll(/M(\d+) (\d+)h(\d+)/g)) {
      for (let py = +y * scale; py < (+y + 1) * scale; py++) {
        for (let px = +x * scale; px < (+x + +n) * scale; px++) {
          const i = (py * width + px) * 4
          pixels[i] = pixels[i + 1] = pixels[i + 2] = 0
        }
      }
    }
  }
  return { pixels, width }
}

describe('QR do pareamento', () => {
  it('ida e volta: o que o SVG desenha o leitor devolve igual', () => {
    const matrix = qrMatrix(PAIR_URL)
    const { pixels, width } = rasterize(qrRowPaths(matrix), matrix.size + 2 * QUIET_ZONE)
    expect(jsQR(pixels, width, width)?.data).toBe(PAIR_URL)
  })

  it('deixa a zona de silêncio de 4 módulos em volta', () => {
    const matrix = qrMatrix('https://exemplo/parear?codigo=ABCDEF')
    const rows = qrRowPaths(matrix)
    const coords = rows.flatMap((d) => [...d.matchAll(/M(\d+) (\d+)/g)].map(([, x, y]) => [+x, +y]))
    expect(Math.min(...coords.map(([x]) => x))).toBe(QUIET_ZONE)
    expect(Math.min(...coords.map(([, y]) => y))).toBe(QUIET_ZONE)
    expect(Math.max(...coords.map(([, y]) => y))).toBe(QUIET_ZONE + matrix.size - 1)
  })
})
