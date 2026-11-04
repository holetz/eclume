// The outcome watcher: with the session open, it reads every 30 s the recordings that changed
// (`GET /recordings?since=`, contract 2.17.0) and announces the end of each one's processing — summary
// ready, summary that failed, ready without a summary, transcription that failed or, since 2.22.0, the recording
// stopped waiting for the speakers' names. The rule and the watermark
// are the desktop's (desktop/crates/sync/src/outcome.rs), with the same test cases. With the tab in
// the background, the outcome adds up in the tab title; with the browser notice turned on in Ambiente,
// it becomes a system notification that opens the recording. It only reads with the tab visible and, with several
// tabs, only one at a time (Web Locks); without the API, each visible tab reads its own. On reappearing, the tab reads
// right away and recovers, through the watermark, what finished while it was hidden.
import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router'
import { api, type Schemas } from '../api/client'
import { unwrap } from '../api/problem'
import { motivo } from '../lib/vocabulario'
import { notifyOutcomesOn } from './preferences'
import { setTitleCount } from './usePageTitle'
import { i18n } from '../i18n'

type Recording = Schemas['Recording']

export type Outcome = 'summary_ready' | 'summary_failed' | 'no_summary' | 'transcription_failed' | 'awaiting_speakers'

export interface Ended {
  recordingId: string
  title: string
  outcome: Outcome
  /** The reason of the skipped step, in the vocabulary of `PipelineStep.reason`. */
  reason: string | null
  /** `finished_at` of the `summary` step, of the waiting `speakers` step or of the job. */
  at: string
}

export const WATCH_MS = 30_000
/** The Web Locks lock name that elects the tab that polls. */
export const WATCH_LOCK = 'eclume-processing-watch'
/** Slack of the watermark and of `?since=`, as in the desktop. */
export const MARGIN_MS = 60_000
const KEEP_MS = 7 * 24 * 60 * 60 * 1000
const PAGE_LIMIT = 200
/** Skipped-step reasons that are the person's own action (or predate the pipeline): no notice. */
const SILENT_REASONS = new Set(['cancelled', 'summary_deleted', 'before_pipeline'])

/** The outcome of a recording, if its processing finished in a way worth announcing. */
export function outcomeOf(recording: Recording): Ended | null {
  const ended = (outcome: Outcome, at: string, reason: string | null = null): Ended => ({
    recordingId: recording.id,
    title: recording.title,
    outcome,
    reason,
    at,
  })
  const job = recording.job
  if (job && recording.status === 'failed' && job.state === 'failed') {
    return job.finished_at ? ended('transcription_failed', job.finished_at) : null
  }
  // Stopped waiting for the names: the account requires naming the speakers and someone is missing.
  const speakers = recording.pipeline?.find((item) => item.step === 'speakers')
  if (speakers?.state === 'waiting' && speakers.finished_at) {
    return ended('awaiting_speakers', speakers.finished_at, speakers.reason ?? null)
  }
  const step = recording.pipeline?.find((item) => item.step === 'summary')
  if (!step?.finished_at) return null
  const reason = step.reason ?? null
  if (step.state === 'done') return ended('summary_ready', step.finished_at, reason)
  if (step.state === 'failed') return ended('summary_failed', step.finished_at, reason)
  if (step.state === 'skipped' && !(reason && SILENT_REASONS.has(reason))) {
    return ended('no_summary', step.finished_at, reason)
  }
  return null
}

/** The next `?since=`, the watermark and the outcomes already announced above it (id → instant). */
export interface Watermark {
  since: string
  mark: string
  notified: Map<string, string>
}

export function startWatermark(now: Date): Watermark {
  return {
    since: new Date(now.getTime() - MARGIN_MS).toISOString(),
    mark: now.toISOString(),
    notified: new Map(),
  }
}

const time = (text: string | null | undefined): number => (text ? Date.parse(text) : Number.NaN)

/** The new outcomes of the `items` read, which now count as announced; advances `since` and the mark. */
export function takeOutcomes(watermark: Watermark, items: Recording[]): Ended[] {
  const mark = time(watermark.mark)
  const fresh: Ended[] = []
  let latest = mark
  for (const ended of items.map(outcomeOf)) {
    if (!ended) continue
    const at = time(ended.at)
    if (Number.isNaN(at)) continue
    latest = Math.max(latest, at)
    if (at > mark && watermark.notified.get(ended.recordingId) !== ended.at) {
      watermark.notified.set(ended.recordingId, ended.at)
      fresh.push(ended)
    }
  }
  if (latest - MARGIN_MS > mark) watermark.mark = new Date(latest - MARGIN_MS).toISOString()
  const updated = items.map((item) => time(item.updated_at)).filter((at) => !Number.isNaN(at))
  if (updated.length > 0) {
    const next = Math.max(...updated) - MARGIN_MS
    if (next > time(watermark.since)) watermark.since = new Date(next).toISOString()
  }
  const keep = time(watermark.mark) - KEEP_MS
  for (const [id, at] of watermark.notified) {
    if (!(time(at) > keep)) watermark.notified.delete(id)
  }
  return fresh
}

/** Title and body of the notice, the desktop's (without its "copy to share" line, which there has the copy button). */
export function outcomeText({ outcome, title, reason }: Ended): { title: string; body: string } {
  const t = i18n.t
  const name = title.trim() || t('shell:outcome.recording')
  switch (outcome) {
    case 'summary_ready':
      return { title: t('shell:outcome.summaryReady'), body: name }
    case 'summary_failed':
      return { title: t('shell:outcome.summaryFailed'), body: t('shell:outcome.summaryFailedBody', { name }) }
    case 'no_summary':
      // The skip reasons are the shared vocabulary (lib/vocabulario.js), still pt-BR until #250.
      return {
        title: t('shell:outcome.noSummary'),
        body: `${name} · ${reason ? motivo(reason) : t('shell:outcome.noReason')}`,
      }
    case 'transcription_failed':
      return { title: t('shell:outcome.transcriptionFailed'), body: t('shell:outcome.transcriptionFailedBody', { name }) }
    case 'awaiting_speakers':
      return { title: t('shell:outcome.awaitingSpeakers'), body: t('shell:outcome.awaitingSpeakersBody', { name }) }
  }
}

async function listSince(since: string): Promise<Recording[]> {
  const items: Recording[] = []
  let cursor: string | null = null
  do {
    const page: Schemas['RecordingPage'] = await unwrap(
      api.GET('/api/v1/recordings', {
        params: { query: { since, limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) } },
      }),
    )
    items.push(...page.items)
    cursor = page.next_cursor
  } while (cursor)
  return items
}

/**
 * Turns the watcher on while the shell (with a session) is mounted. Outcomes before mounting do not
 * notify: reopening the browser or refreshing the app does not fire an old notice.
 */
export function useProcessingWatch(): void {
  const navigate = useNavigate()
  const navigateRef = useRef(navigate)
  useEffect(() => {
    navigateRef.current = navigate
  }, [navigate])

  useEffect(() => {
    const watermark = startWatermark(new Date())
    let unseen = 0
    let stopped = false

    const onVisibility = () => {
      if (!document.hidden && unseen > 0) {
        unseen = 0
        setTitleCount(0)
      }
    }

    const notify = (ended: Ended) => {
      const { title, body } = outcomeText(ended)
      // `tag`: several open tabs do not stack the same notice.
      const notification = new Notification(title, { body, tag: ended.recordingId })
      notification.onclick = () => {
        window.focus()
        navigateRef.current(`/gravacoes/${ended.recordingId}`)
        notification.close()
      }
    }

    const tick = async () => {
      let items: Recording[]
      try {
        items = await listSince(watermark.since)
      } catch {
        // No network or no session: the next round tries again (the session that drops is #111's).
        return
      }
      if (stopped) return
      const fresh = takeOutcomes(watermark, items)
      if (fresh.length === 0) return
      if (document.hidden) {
        unseen += fresh.length
        setTitleCount(unseen)
      }
      if (notifyOutcomesOn()) fresh.forEach(notify)
    }

    // Who polls: the visible tab holding the lock (or any visible tab, without Web Locks). The lock is
    // held until the tab hides or unmounts, and then passes to the next visible tab in the queue.
    let release: (() => void) | null = null
    let abort: AbortController | null = null
    let active = false

    const poll = (immediate: boolean) => () =>
      new Promise<void>((resolve) => {
        if (immediate) void tick()
        const timer = window.setInterval(() => void tick(), WATCH_MS)
        release = () => {
          window.clearInterval(timer)
          release = null
          resolve()
        }
      })

    const start = (immediate: boolean) => {
      if (active) return
      active = true
      if (typeof navigator !== 'undefined' && navigator.locks) {
        abort = new AbortController()
        navigator.locks.request(WATCH_LOCK, { signal: abort.signal }, poll(immediate)).catch(() => undefined)
      } else {
        void poll(immediate)()
      }
    }

    const stop = () => {
      active = false
      abort?.abort()
      abort = null
      release?.()
    }

    const onChange = () => {
      onVisibility()
      if (document.hidden) stop()
      else start(true)
    }

    if (!document.hidden) start(false)
    document.addEventListener('visibilitychange', onChange)
    return () => {
      stopped = true
      stop()
      document.removeEventListener('visibilitychange', onChange)
      setTitleCount(0)
    }
  }, [])
}
