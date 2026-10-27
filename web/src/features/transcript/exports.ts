// Export the recording through the API client (not through a link): the error comes as a problem and becomes an alert on
// screen, instead of the browser downloading a JSON, and a 401 ends the session like any other call.
import { api } from '../../api/client'
import { unwrap } from '../../api/problem'
import type { operations } from '../../api/schema.gen'

export type ExportFormat = operations['exportRecording']['parameters']['query']['format']

/** The file name from `Content-Disposition` (`filename*` UTF-8 or `filename`). */
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
  // Revoking right after the click can abort the download in Safari and Firefox.
  setTimeout(() => URL.revokeObjectURL(href), 60_000)
}
