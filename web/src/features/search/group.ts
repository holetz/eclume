// The search results grouped by recording, without touching the ranking: only the consecutive hits of the
// same transcript are joined, so the same recording can show up in two groups.
import { i18n } from '../../i18n'
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
  const passages = i18n.t('search:total.passages', { count: hits.length })
  const where = i18n.t('search:total.recordings', { count: recordings })
  return i18n.t(more ? 'search:total.lineMore' : 'search:total.line', { passages, where })
}
