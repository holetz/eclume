// O observador de desfechos: com a sessão aberta, lê a cada 30 s as gravações que mudaram
// (`GET /recordings?since=`, contrato 2.17.0) e avisa o fim do processamento de cada uma — resumo
// pronto, resumo que falhou, pronta sem resumo ou transcrição que falhou. A regra e a marca d'água
// são as do desktop (desktop/crates/sync/src/outcome.rs), com os mesmos casos de teste. Com a aba em
// segundo plano, o desfecho soma no título da aba; com o aviso do navegador ligado em Ambiente,
// vira uma notificação do sistema que abre a gravação.
import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router'
import { api, type Schemas } from '../api/client'
import { unwrap } from '../api/problem'
import { motivo } from '../lib/vocabulario'
import { notifyOutcomesOn } from './preferences'
import { setTitleCount } from './usePageTitle'

type Recording = Schemas['Recording']

export type Outcome = 'summary_ready' | 'summary_failed' | 'no_summary' | 'transcription_failed'

export interface Ended {
  recordingId: string
  title: string
  outcome: Outcome
  /** O motivo da etapa pulada, no vocabulário de `PipelineStep.reason`. */
  reason: string | null
  /** `finished_at` da etapa `summary` ou do job. */
  at: string
}

export const WATCH_MS = 30_000
/** Folga da marca d'água e do `?since=`, como no desktop. */
export const MARGIN_MS = 60_000
const KEEP_MS = 7 * 24 * 60 * 60 * 1000
const PAGE_LIMIT = 200
/** Motivos de etapa pulada que são ação da própria pessoa (ou anteriores ao pipeline): sem aviso. */
const SILENT_REASONS = new Set(['cancelled', 'summary_deleted', 'before_pipeline'])

/** O desfecho de uma gravação, se o processamento dela terminou de um jeito avisável. */
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

/** O próximo `?since=`, a marca d'água e os desfechos já avisados acima dela (id → instante). */
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

/** Os desfechos novos da leitura `items`, que passam a contar como avisados; avança `since` e a marca. */
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

/** Título e corpo do aviso, os do desktop (sem o "copie para compartilhar", que lá tem o Copiar). */
export function outcomeText({ outcome, title, reason }: Ended): { title: string; body: string } {
  const name = title.trim() || 'Gravação'
  switch (outcome) {
    case 'summary_ready':
      return { title: 'Resumo pronto', body: name }
    case 'summary_failed':
      return { title: 'O resumo falhou', body: `${name} · abra para gerar de novo` }
    case 'no_summary':
      return { title: 'Pronta sem resumo', body: `${name} · ${reason ? motivo(reason) : 'sem motivo informado'}` }
    case 'transcription_failed':
      return { title: 'A transcrição falhou', body: `${name} · abra para ver o motivo` }
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
 * Liga o observador enquanto a casca (com sessão) está montada. Desfechos anteriores à montagem não
 * avisam: reabrir o navegador ou atualizar o app não dispara aviso antigo.
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
      // `tag`: várias abas abertas não empilham o mesmo aviso.
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
        // Sem rede ou sem sessão: a próxima volta tenta de novo (a sessão que cai é da #111).
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

    const timer = window.setInterval(() => void tick(), WATCH_MS)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stopped = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
      setTitleCount(0)
    }
  }, [])
}
