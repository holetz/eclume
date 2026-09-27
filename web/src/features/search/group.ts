// Os resultados da busca agrupados por gravação, sem mexer no ranking: só os acertos consecutivos da
// mesma transcrição se juntam, então a mesma gravação pode aparecer em dois grupos.
import type { Schemas } from '../../api/client'

type Hit = Schemas['SearchHit']

export interface HitGroup {
  transcript: Hit['transcript']
  hits: Hit[]
}

export function groupHits(hits: readonly Hit[]): HitGroup[] {
  const groups: HitGroup[] = []
  for (const hit of hits) {
    const last = groups[groups.length - 1]
    if (last && last.transcript.id === hit.transcript.id) last.hits.push(hit)
    else groups.push({ transcript: hit.transcript, hits: [hit] })
  }
  return groups
}

/** "7 trechos em 3 gravações" (com "ou mais" quando há outra página). */
export function totalLabel(hits: readonly Hit[], more: boolean): string {
  const recordings = new Set(hits.map((hit) => hit.transcript.recording_id)).size
  const passages = hits.length === 1 ? '1 trecho' : `${hits.length} trechos`
  const where = recordings === 1 ? '1 gravação' : `${recordings} gravações`
  return `${passages} em ${where}${more ? ' ou mais' : ''}`
}
