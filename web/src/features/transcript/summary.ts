// O resumo da gravação com versões: o estado (atual, gerada de referência e geração em andamento) e as
// mutações — editar à mão, voltar à gerada, excluir, gerar e trocar o tipo de agenda.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Schemas } from '../../api/client'
import { ApiError, unwrap } from '../../api/problem'
import { pollWhile } from '../../app/polling'
import { recordingKey, summaryKey } from './queries'

type Summary = Schemas['Summary']
export type SummaryState = Schemas['SummaryState']

const POLL_MS = 3000

export function useSummaryState(recordingId: string, enabled = true) {
  return useQuery({
    queryKey: summaryKey(recordingId),
    enabled,
    queryFn: () =>
      unwrap(api.GET('/api/v1/recordings/{recording_id}/summary', { params: { path: { recording_id: recordingId } } })),
    refetchOnWindowFocus: true,
    refetchInterval: pollWhile((data: SummaryState | undefined) => !!data?.pending, POLL_MS),
  })
}

/** "Do tipo de agenda", "Editado por você", "Voltou à gerada" ou "Ajustado pelo chat". */
export function originLabel(summary: Pick<Summary, 'origin' | 'restored_from_id'>): string {
  if (summary.origin === 'generated') return 'Do tipo de agenda'
  if (summary.origin === 'chat') return 'Ajustado pelo chat'
  return summary.restored_from_id ? 'Voltou à gerada' : 'Editado por você'
}

/** O 422 de gerar sem tipo de agenda (nem o pedido nem o da gravação). */
export function isMissingType(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 422 &&
    (error.problem?.errors?.some((item) => item.field === 'agenda_type_id') ?? false)
  )
}

/** O 422 de gerar o resumo sem agente de resumo configurado (`provider_id`). */
export function isMissingProvider(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 422 &&
    (error.problem?.errors?.some((item) => item.field === 'provider_id') ?? false)
  )
}

/** O 409 de uma edição cuja versão de base já não é a atual. */
export function isSummaryChanged(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'summary_changed'
}

export function useSummaryMutations(recording: Pick<Schemas['Recording'], 'id' | 'transcript_id'>) {
  const queryClient = useQueryClient()
  const path = { params: { path: { recording_id: recording.id } } }
  const refresh = () => queryClient.invalidateQueries({ queryKey: summaryKey(recording.id) })

  const edit = useMutation({
    mutationFn: (body: Schemas['SummaryEdit']) =>
      unwrap(api.PUT('/api/v1/recordings/{recording_id}/summary', { ...path, body })),
    onSuccess: refresh,
  })
  const revert = useMutation({
    mutationFn: () => unwrap(api.POST('/api/v1/recordings/{recording_id}/summary/revert', path)),
    onSuccess: refresh,
  })
  const remove = useMutation({
    mutationFn: () => unwrap(api.DELETE('/api/v1/recordings/{recording_id}/summary', path)),
    onSuccess: refresh,
  })
  const generate = useMutation({
    mutationFn: (agendaTypeId?: string) =>
      unwrap(
        api.POST('/api/v1/transcripts/{transcript_id}/summaries', {
          params: { path: { transcript_id: recording.transcript_id! } },
          body: agendaTypeId ? { agenda_type_id: agendaTypeId } : {},
        }),
      ),
    onSuccess: refresh,
  })
  const changeType = useMutation({
    mutationFn: (agendaTypeId: string) =>
      unwrap(api.PATCH('/api/v1/recordings/{recording_id}', { ...path, body: { agenda_type_id: agendaTypeId } })),
    onSuccess: (updated) => {
      queryClient.setQueryData(recordingKey(recording.id), updated)
      void refresh()
      void queryClient.invalidateQueries({ queryKey: ['recordings'] })
    },
  })
  return { edit, revert, remove, generate, changeType }
}
