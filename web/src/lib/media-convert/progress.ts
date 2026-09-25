export interface ConvertProgress {
  /** Fração convertida, de 0 a 1, nunca decrescente. */
  ratio: number
  /**
   * Bytes efetivamente lidos do arquivo de entrada até agora. Pode terminar abaixo de
   * `bytesTotal`: o demuxer pula os dados de vídeo que não precisa ler.
   */
  bytesRead: number
  bytesTotal: number
}

export type ProgressCallback = (progress: ConvertProgress) => void

/** Agrega a razão do motor e as leituras da fonte num progresso monótono. */
export class ProgressTracker {
  private ratio = 0
  private bytesRead = 0
  private readonly bytesTotal: number
  private readonly onProgress?: ProgressCallback

  constructor(bytesTotal: number, onProgress?: ProgressCallback) {
    this.bytesTotal = bytesTotal
    this.onProgress = onProgress
  }

  /** Soma `count` bytes lidos da entrada. */
  addBytesRead(count: number): void {
    this.bytesRead = Math.min(this.bytesTotal, this.bytesRead + Math.max(0, count))
    this.emit()
  }

  /** Atualiza a razão; valores fora de [0, 1] são limitados e recuos são ignorados. */
  setRatio(ratio: number): void {
    if (!Number.isFinite(ratio)) return
    this.ratio = Math.max(this.ratio, Math.min(1, Math.max(0, ratio)))
    this.emit()
  }

  complete(): void {
    this.ratio = 1
    this.emit()
  }

  snapshot(): ConvertProgress {
    return { ratio: this.ratio, bytesRead: this.bytesRead, bytesTotal: this.bytesTotal }
  }

  private emit(): void {
    this.onProgress?.(this.snapshot())
  }
}
