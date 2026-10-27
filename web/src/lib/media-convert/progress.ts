export interface ConvertProgress {
  /** Converted fraction, from 0 to 1, never decreasing. */
  ratio: number
  /**
   * Bytes actually read from the input file so far. It may end below
   * `bytesTotal`: the demuxer skips the video data it does not need to read.
   */
  bytesRead: number
  bytesTotal: number
}

export type ProgressCallback = (progress: ConvertProgress) => void

/** Combines the engine's ratio and the source reads into monotonic progress. */
export class ProgressTracker {
  private ratio = 0
  private bytesRead = 0
  private readonly bytesTotal: number
  private readonly onProgress?: ProgressCallback

  constructor(bytesTotal: number, onProgress?: ProgressCallback) {
    this.bytesTotal = bytesTotal
    this.onProgress = onProgress
  }

  /** Adds `count` bytes read from the input. */
  addBytesRead(count: number): void {
    this.bytesRead = Math.min(this.bytesTotal, this.bytesRead + Math.max(0, count))
    this.emit()
  }

  /**
   * Updates the ratio; values outside [0, 1] are clamped and regressions are ignored. `bytesRead`,
   * when given, replaces the count (engines that do not expose the source reads).
   */
  setRatio(ratio: number, bytesRead?: number): void {
    if (!Number.isFinite(ratio)) return
    this.ratio = Math.max(this.ratio, Math.min(1, Math.max(0, ratio)))
    if (bytesRead !== undefined) {
      this.bytesRead = Math.max(this.bytesRead, Math.min(this.bytesTotal, bytesRead))
    }
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
