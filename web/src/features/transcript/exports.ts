// Exportar a gravação pelo cliente da API (e não por link): o erro vem como problem e vira alerta na
// tela, em vez de o navegador baixar um JSON, e um 401 encerra a sessão como qualquer outra chamada.
import { api } from '../../api/client'
import { unwrap } from '../../api/problem'
import type { operations } from '../../api/schema.gen'

export type ExportFormat = operations['exportRecording']['parameters']['query']['format']

/** O nome do arquivo do `Content-Disposition` (`filename*` UTF-8 ou `filename`). */
function dispositionName(header: string | null): string | null {
  if (!header) return null
  const extended = /filename\*=UTF-8''([^;]+)/i.exec(header)
  if (extended) return decodeURIComponent(extended[1].trim())
  const plain = /filename="?([^";]+)"?/i.exec(header)
  return plain ? plain[1].trim() : null
}

export async function downloadExport(recordingId: string, format: ExportFormat): Promise<void> {
  const call = api.GET('/api/v1/recordings/{recording_id}/export', {
    params: { path: { recording_id: recordingId }, query: { format } },
    parseAs: 'blob',
  })
  const blob = await unwrap(call)
  const { response } = await call
  const href = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = href
  link.download = dispositionName(response.headers.get('Content-Disposition')) ?? `gravacao.${format}`
  document.body.append(link)
  link.click()
  link.remove()
  // Revogar logo após o clique pode abortar o download no Safari e no Firefox.
  setTimeout(() => URL.revokeObjectURL(href), 60_000)
}
