import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, useState, type FormEvent } from 'react'
import { api } from '../../api/client'
import { errorMessage, unwrap } from '../../api/problem'
import { updateTranscriptCache } from './queries'
import type { Segment } from './segments'
import styles from './TranscriptView.module.css'

interface SegmentEditorProps {
  transcriptId: string
  segment: Segment
  label: string
  onClose: () => void
}

/** Correção do texto de uma fala. Salva com Ctrl+Enter e cancela com Esc. */
export function SegmentEditor({ transcriptId, segment, label, onClose }: SegmentEditorProps) {
  const queryClient = useQueryClient()
  const [text, setText] = useState(segment.text)
  const fieldId = useId()
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.PATCH('/api/v1/transcripts/{transcript_id}/segments/{segment_id}', {
          params: { path: { transcript_id: transcriptId, segment_id: segment.id } },
          body: { text },
        }),
      ),
    onSuccess: (updated) => {
      updateTranscriptCache(queryClient, transcriptId, (t) => ({
        ...t,
        segments: t.segments.map((s) => (s.id === updated.id ? updated : s)),
      }))
      onClose()
    },
  })

  function submit(event: FormEvent) {
    event.preventDefault()
    if (text === segment.text) onClose()
    else save.mutate()
  }

  return (
    <form className={styles.editor} onSubmit={submit}>
      <label htmlFor={fieldId} className="visually-hidden">
        {label}
      </label>
      <textarea
        id={fieldId}
        className="input"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose()
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) event.currentTarget.form?.requestSubmit()
        }}
        rows={Math.min(8, Math.max(3, Math.ceil(text.length / 80)))}
        autoFocus
      />
      {save.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(save.error)}
        </p>
      )}
      <div className={styles.editorActions}>
        <button type="submit" className="btn btn-primary btn-sm" disabled={save.isPending}>
          {save.isPending ? 'Salvando…' : 'Salvar'}
        </button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>
          Cancelar
        </button>
        <span className={styles.hint}>Ctrl+Enter salva · Esc cancela</span>
      </div>
    </form>
  )
}
