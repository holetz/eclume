import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useId, useState } from 'react'
import Markdown from 'react-markdown'
import { api, type Schemas } from '../../api/client'
import { errorMessage, unwrap } from '../../api/problem'
import { formatDateTime, type Tone } from '../library/format'
import styles from './SummariesPanel.module.css'

type Summary = Schemas['Summary']

const POLL_MS = 3000

const STATUS: Record<string, { label: string; tone: Tone }> = {
  queued: { label: 'Na fila', tone: 'neutral' },
  running: { label: 'Gerando', tone: 'progress' },
  done: { label: 'Pronto', tone: 'success' },
  failed: { label: 'Falhou', tone: 'danger' },
}

const summariesKey = (transcriptId: string) => ['summaries', transcriptId] as const

function isPending(summary: Summary) {
  return summary.status === 'queued' || summary.status === 'running'
}

export function SummariesPanel({ transcriptId }: { transcriptId: string }) {
  const queryClient = useQueryClient()
  const titleId = useId()
  const templateId = useId()
  const [chosen, setChosen] = useState<string | null>(null)

  const templates = useQuery({
    queryKey: ['summary-templates'],
    queryFn: () => unwrap(api.GET('/api/v1/summary-templates', { params: { query: { limit: 100 } } })),
    staleTime: 60_000,
  })
  const summaries = useQuery({
    queryKey: summariesKey(transcriptId),
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/transcripts/{transcript_id}/summaries', {
          params: { path: { transcript_id: transcriptId } },
        }),
      ),
    refetchInterval: (query) => (query.state.data?.items.some(isPending) ? POLL_MS : false),
  })
  const generate = useMutation({
    mutationFn: (template: string) =>
      unwrap(
        api.POST('/api/v1/transcripts/{transcript_id}/summaries', {
          params: { path: { transcript_id: transcriptId } },
          body: { template_id: template },
        }),
      ),
    onSuccess: (created) => {
      queryClient.setQueryData<Schemas['SummaryPage']>(summariesKey(transcriptId), (page) =>
        page ? { ...page, items: [created, ...page.items.filter((s) => s.id !== created.id)] } : page,
      )
    },
  })

  const templateItems = templates.data?.items ?? []
  const selected = chosen ?? templateItems.find((t) => t.is_default)?.id ?? templateItems[0]?.id ?? ''

  return (
    <section className={`card ${styles.panel}`} aria-labelledby={titleId}>
      <h2 id={titleId}>Resumos</h2>

      {templates.isError ? (
        <p className="alert alert-error" role="alert">
          {errorMessage(templates.error)}
        </p>
      ) : (
        <form
          className={styles.generate}
          onSubmit={(event) => {
            event.preventDefault()
            if (selected) generate.mutate(selected)
          }}
        >
          <div className="field">
            <label htmlFor={templateId}>Template</label>
            <select
              id={templateId}
              className="select"
              value={selected}
              onChange={(event) => setChosen(event.target.value)}
              disabled={templateItems.length === 0}
            >
              {templateItems.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className="btn btn-primary btn-sm" disabled={!selected || generate.isPending}>
            {generate.isPending ? 'Pedindo…' : 'Gerar resumo'}
          </button>
          {generate.isError && (
            <p className="alert alert-error" role="alert">
              {errorMessage(generate.error)}
            </p>
          )}
        </form>
      )}

      {summaries.isPending && <p role="status">Carregando resumos…</p>}
      {summaries.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(summaries.error)}
        </p>
      )}
      {summaries.data?.items.length === 0 && <p className="muted">Nenhum resumo gerado ainda.</p>}
      {summaries.data && summaries.data.items.length > 0 && (
        <ul className={styles.list} aria-label="Resumos gerados">
          {summaries.data.items.map((summary) => (
            <SummaryItem key={summary.id} summary={summary} />
          ))}
        </ul>
      )}
    </section>
  )
}

function SummaryItem({ summary }: { summary: Summary }) {
  const status = STATUS[summary.status] ?? { label: summary.status, tone: 'neutral' }
  const heading = (
    <span className={styles.head}>
      <span className={styles.name}>
        {summary.template.name} <span className="muted">· v{summary.version}</span>
      </span>
      <span className={`badge badge-${status.tone}`}>{status.label}</span>
    </span>
  )
  return (
    <li className={styles.item}>
      {summary.status === 'done' && summary.content_md ? (
        <details>
          <summary className={styles.toggle}>{heading}</summary>
          <div className={styles.content}>
            <Markdown>{summary.content_md}</Markdown>
          </div>
        </details>
      ) : (
        heading
      )}
      <span className={styles.detail}>
        {formatDateTime(summary.created_at)} · {summary.provider.name}
      </span>
      {summary.status === 'failed' && summary.error && <span className={styles.error}>{summary.error.message}</span>}
    </li>
  )
}
