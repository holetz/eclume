import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import type { Schemas } from '../../api/client'
import { errorMessage } from '../../api/problem'
import { ConfirmDialog } from '../../app/ConfirmDialog'
import { recordingKey, useContinueWithoutNames, useTranscript } from './queries'

type Recording = Schemas['Recording']

/** Quem está ligado a quem, numa chave só: muda quando um locutor ganha ou perde pessoa. */
function linksOf(speakers: { id: string; person?: { id: string } | null }[] | undefined): string {
  return (speakers ?? []).map((speaker) => `${speaker.id}:${speaker.person?.id ?? ''}`).join('|')
}

/**
 * O aviso da gravação parada à espera dos nomes dos locutores (etapa `speakers` em `waiting`):
 * leva ao painel de locutores e oferece Seguir sem nomear. Ligar uma pessoa no painel muda a
 * transcrição em cache; aí a gravação é relida, e o servidor já terá soltado a cadeia se o último
 * locutor ganhou nome.
 */
export function AwaitingSpeakers({ recording }: { recording: Recording }) {
  const waiting = recording.pipeline.some((step) => step.step === 'speakers' && step.state === 'waiting')
  const queryClient = useQueryClient()
  const transcript = useTranscript(waiting ? recording.transcript_id : null)
  const links = linksOf(transcript.data?.speakers)
  const previous = useRef<string | null>(null)
  const resume = useContinueWithoutNames(recording.id)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    if (!transcript.data) return
    const before = previous.current
    previous.current = links
    if (before !== null && before !== links) void queryClient.invalidateQueries({ queryKey: recordingKey(recording.id) })
  }, [links, queryClient, recording.id, transcript.data])

  if (!waiting) return null
  return (
    <div className="alert alert-warning" role="status" aria-label="Aguardando locutores">
      <p className="alert-title">Aguardando locutores</p>
      <p>
        Sua conta exige que cada locutor tenha uma pessoa antes do tipo de agenda, dos campos, das coleções e do
        resumo. Ligue os locutores sem pessoa em <a href="#locutores">Locutores</a>: quando o último tiver nome, o
        processamento segue sozinho.
      </p>
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => setConfirming(true)}>
        Seguir sem nomear
      </button>
      {resume.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(resume.error)}
        </p>
      )}
      {confirming && (
        <ConfirmDialog
          title="Seguir sem nomear os locutores?"
          confirmLabel="Seguir sem nomear"
          busy={resume.isPending}
          onCancel={() => setConfirming(false)}
          onConfirm={() => resume.mutate(undefined, { onSettled: () => setConfirming(false) })}
        >
          O tipo, os campos, as coleções e o resumo seguem agora, com &ldquo;Locutor N&rdquo; no lugar de quem ainda não
          tem pessoa. Você pode nomear os locutores depois e gerar o resumo de novo.
        </ConfirmDialog>
      )}
    </div>
  )
}
