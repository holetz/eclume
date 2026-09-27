// Exportar a gravação por fetch (e não por link): o erro vem como problem e vira alerta na tela, em
// vez de o navegador baixar um JSON.
import { ApiError, type Problem } from '../../api/problem'

export type ExportFormat = 'txt' | 'srt' | 'md' | 'docx'

/** O nome do arquivo do `Content-Disposition` (`filename*` UTF-8 ou `filename`). */
export function dispositionName(header: string | null): string | null {
  if (!header) return null
  const extended = /filename\*=UTF-8''([^;]+)/i.exec(header)
  if (extended) return decodeURIComponent(extended[1].trim())
  const plain = /filename="?([^";]+)"?/i.exec(header)
  return plain ? plain[1].trim() : null
}

export async function downloadExport(recordingId: string, format: ExportFormat): Promise<void> {
  const url = new URL(`/api/v1/recordings/${recordingId}/export?format=${format}`, window.location.origin)
  const response = await fetch(url, { credentials: 'same-origin' })
  if (!response.ok) {
    const problem = (await response.json().catch(() => null)) as Problem | null
    throw new ApiError(response.status, problem)
  }
  const blob = await response.blob()
  const href = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = href
  link.download = dispositionName(response.headers.get('Content-Disposition')) ?? `gravacao.${format}`
  document.body.append(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(href)
}
