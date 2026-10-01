import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { Schemas } from '../../api/client'
import { api } from '../../api/client'
import { errorMessage, unwrap } from '../../api/problem'
import { useMe } from '../../app/session'
import { recordingKey } from './queries'

type Recording = Schemas['Recording']

/**
 * Retentar a transcrição que falhou (retranscrever, uma revisão acima). Só o dono escreve na
 * gravação; a falha passageira (worker perdido, job sumido, falta de VRAM) é dita como tal.
 */
export function RetryTranscription({ recording }: { recording: Recording }) {
  const me = useMe()
  const queryClient = useQueryClient()
  const retry = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/api/v1/recordings/{recording_id}/retranscribe', {
          params: { path: { recording_id: recording.id } },
        }),
      ),
    onSuccess: (updated) => {
      queryClient.setQueryData(recordingKey(recording.id), updated)
      void queryClient.invalidateQueries({ queryKey: ['recordings'] })
    },
  })

  if (recording.status !== 'failed' || me.data?.user.id !== recording.owner.id) return null
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
          {errorMessage(retry.error)}
        </p>
      )}
    </div>
  )
}
