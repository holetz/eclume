// The search results grouped by recording, without touching the ranking: only the consecutive hits of the
// same transcript are joined, so the same recording can show up in two groups.
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

/** "7 trechos em 3 gravações" (with "ou mais" when there is another page). */
export function totalLabel(hits: readonly Hit[], more: boolean): string {
  const recordings = new Set(hits.map((hit) => hit.transcript.recording_id)).size
  const passages = hits.length === 1 ? '1 trecho' : `${hits.length} trechos`
  const where = recordings === 1 ? '1 gravação' : `${recordings} gravações`
  return `${passages} em ${where}${more ? ' ou mais' : ''}`
}
