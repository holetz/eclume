import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, useState } from 'react'
import type { Schemas } from '../../api/client'
import { api } from '../../api/client'
import { ApiError, errorMessage, unwrap } from '../../api/problem'
import { ConfirmDialog } from '../../app/ConfirmDialog'
import { AUTO_LANGUAGE } from '../../lib/languages'
import { LanguageSelect } from '../../shared/LanguageSelect'
import { recordingKey } from './queries'

type Recording = Schemas['Recording']

/** Retranscrever (uma revisão acima), com o idioma pedido ou o da gravação. */
function useRetranscribe(recording: Recording) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (language?: string) =>
      unwrap(
        api.POST('/api/v1/recordings/{recording_id}/retranscribe', {
          params: { path: { recording_id: recording.id } },
          ...(language ? { body: { language } } : {}),
        }),
      ),
    onSuccess: (updated) => {
      queryClient.setQueryData(recordingKey(recording.id), updated)
      void queryClient.invalidateQueries({ queryKey: ['recordings'] })
    },
  })
}

/** O 409 do pedido duplicado dito em palavras; o resto pelo `errorMessage`. */
function retranscribeError(error: unknown): string {
  return error instanceof ApiError && error.status === 409
    ? 'Já há uma transcrição em andamento.'
    : errorMessage(error)
}

/**
 * Retentar a transcrição que falhou (retranscrever, uma revisão acima). Toda gravação que a conta
 * vê é dela (o `owner` do contrato é obsoleto); a falha passageira (worker perdido, job sumido,
 * falta de VRAM) é dita como tal, e um 403/404 da rota aparece pelo `errorMessage`.
 */
export function RetryTranscription({ recording }: { recording: Recording }) {
  const retry = useRetranscribe(recording)

  if (recording.status !== 'failed') return null
  const cancelled = recording.job?.error?.code === 'cancelled'
  const retryable = recording.job?.error?.retryable === true
  return (
    <div role="group" aria-label="Retentar a transcrição">
      <p className="text-muted">
        {cancelled
          ? 'Você cancelou a transcrição: pode transcrever de novo quando quiser.'
          : retryable
            ? 'A falha foi passageira: tentar de novo costuma resolver.'
            : 'Você pode tentar de novo com a configuração atual.'}
      </p>
      <button type="button" className="btn btn-secondary" disabled={retry.isPending} onClick={() => retry.mutate()}>
        {retry.isPending ? 'Enfileirando…' : cancelled ? 'Transcrever de novo' : 'Tentar de novo'}
      </button>
      {retry.isError && (
        <p className="alert alert-error" role="alert">
          {retranscribeError(retry.error)}
        </p>
      )}
    </div>
  )
}

/**
 * Transcrever de novo em…: o dono escolhe o idioma a qualquer momento (sem job em aberto), e a
 * confirmação diz o que muda na revisão nova.
 */
export function RetranscribeAction({ recording }: { recording: Recording }) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [language, setLanguage] = useState(() => recording.language?.split('-', 1)[0] ?? AUTO_LANGUAGE)
  const retranscribe = useRetranscribe(recording)

  if (recording.status !== 'transcribed' && recording.status !== 'failed') return null
  return (
    <>
      <button type="button" className="btn btn-secondary" onClick={() => setOpen(true)}>
        Transcrever de novo em…
      </button>
      {open && (
        <ConfirmDialog
          title="Transcrever de novo?"
          confirmLabel="Transcrever de novo"
          busy={retranscribe.isPending}
          onCancel={() => setOpen(false)}
          onConfirm={() => retranscribe.mutate(language, { onSuccess: () => setOpen(false) })}
        >
          <div className="field">
            <label htmlFor={id}>Idioma</label>
            <LanguageSelect id={id} value={language} onChange={setLanguage} disabled={retranscribe.isPending} />
          </div>
          <p>
            A transcrição é refeita numa revisão nova: as correções de texto feitas à mão se perdem, as pessoas ligadas
            aos locutores voltam e os campos, o tipo de agenda e o resumo são refeitos.
          </p>
          {retranscribe.isError && (
            <p className="alert alert-error" role="alert">
              {retranscribeError(retranscribe.error)}
            </p>
          )}
        </ConfirmDialog>
      )}
    </>
  )
}
