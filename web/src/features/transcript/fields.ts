// Os campos da gravação (título, tags e os campos do usuário) com a origem de cada valor, e as
// mutações de editar e aceitar o preenchimento automático.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Schemas } from '../../api/client'
import { unwrap } from '../../api/problem'
import { fieldsKey, recordingKey } from './queries'

export type FieldValue = Schemas['RecordingFieldValue']

/** "a, b,, a " → ["a", "b"]: sem vazios nem repetidos, na ordem digitada. */
export function parseTags(value: string): string[] {
  return [
    ...new Set(
      value
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ]
}

/** Os embutidos (título e tags) primeiro, depois os do usuário, na ordem da lista. */
export function sortFields(items: readonly FieldValue[]): FieldValue[] {
  const rank = (item: FieldValue) => (item.field.builtin === 'title' ? 0 : item.field.builtin === 'tags' ? 1 : 2)
  return [...items].sort((a, b) => rank(a) - rank(b) || a.field.position - b.field.position)
}

export function useRecordingFields(recordingId: string, enabled = true) {
  return useQuery({
    queryKey: fieldsKey(recordingId),
    enabled,
    queryFn: () =>
      unwrap(api.GET('/api/v1/recordings/{recording_id}/fields', { params: { path: { recording_id: recordingId } } })),
  })
}

export function useFieldMutations(recordingId: string) {
  const queryClient = useQueryClient()
  const path = { recording_id: recordingId }
  const store = (values: Schemas['RecordingFieldValues'], touchedBuiltin: boolean) => {
    queryClient.setQueryData(fieldsKey(recordingId), values)
    // Título e tags vivem também na gravação: relê a gravação e a biblioteca.
    if (touchedBuiltin) {
      void queryClient.invalidateQueries({ queryKey: recordingKey(recordingId), exact: true })
      void queryClient.invalidateQueries({ queryKey: ['recordings'] })
    }
  }

  const put = useMutation({
    mutationFn: ({ field, value }: { field: Schemas['Field']; value: Schemas['FieldValuePut']['value'] }) =>
      unwrap(
        api.PUT('/api/v1/recordings/{recording_id}/fields/{field_id}', {
          params: { path: { ...path, field_id: field.id } },
          body: { value },
        }),
      ),
    onSuccess: (values, { field }) => store(values, field.builtin !== null),
  })
  const accept = useMutation({
    mutationFn: (field: Schemas['Field']) =>
      unwrap(
        api.POST('/api/v1/recordings/{recording_id}/fields/{field_id}/accept', {
          params: { path: { ...path, field_id: field.id } },
        }),
      ),
    onSuccess: (values) => store(values, false),
  })
  const acceptAll = useMutation({
    mutationFn: () => unwrap(api.POST('/api/v1/recordings/{recording_id}/fields/accept', { params: { path } })),
    onSuccess: (values) => store(values, false),
  })
  return { put, accept, acceptAll }
}
