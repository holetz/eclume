// User fields and agenda types (Organizar), with the previews that test a draft
// without saving anything. Few per user: one page covers the whole screen.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Schemas } from '../../api/client'
import { ApiError, unwrap } from '../../api/problem'

export type Field = Schemas['Field']
export type FieldDraft = Schemas['FieldDraft']
export type FieldKind = Schemas['FieldKind']
export type AgendaType = Schemas['AgendaType']
export type AgendaTypeDraft = Schemas['AgendaTypeDraft']
export type Preview = Schemas['Preview']

export const KIND_LABELS: Record<FieldKind, string> = { text: 'Texto', list: 'Lista', choice: 'Escolha' }

/** The draft of a field in the contract's shape: name without spaces at the ends, and only Choice carries options. */
export function cleanDraft(draft: FieldDraft): FieldDraft {
  return { ...draft, name: draft.name.trim(), options: draft.kind === 'choice' ? draft.options : [] }
}

/** The contract's 422 errors per form field (`name`, `options`; `field.name` and `agenda_type.name` in the previews). */
export function invalidFields(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError) || error.problem?.code !== 'validation_failed') return {}
  const byField: Record<string, string> = {}
  for (const { field, message } of error.problem.errors ?? []) {
    byField[field.replace(/^(field|agenda_type)\./, '').replace(/\[\d+\]$/, '')] = message
  }
  return byField
}

const FIELDS_KEY = ['fields'] as const
// A single query, also used by the recording's summaries panel (switching the agenda type).
const AGENDA_TYPES_KEY = ['agenda-types'] as const

export function useFields() {
  return useQuery({ queryKey: FIELDS_KEY, queryFn: () => unwrap(api.GET('/api/v1/fields')) })
}

/** Creates (without `id`) or edits a field. */
export function useSaveField() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, draft }: { id: string | null; draft: FieldDraft }) =>
      id
        ? unwrap(api.PATCH('/api/v1/fields/{field_id}', { params: { path: { field_id: id } }, body: draft }))
        : unwrap(api.POST('/api/v1/fields', { body: draft })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: FIELDS_KEY }),
  })
}

/** The list's "Automático" toggle: optimistic, and it reverts to the previous value if the server refuses. */
export function useSetAutoFill() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, autoFill }: { id: string; autoFill: boolean }) =>
      unwrap(api.PATCH('/api/v1/fields/{field_id}', { params: { path: { field_id: id } }, body: { auto_fill: autoFill } })),
    onMutate: async ({ id, autoFill }) => {
      await queryClient.cancelQueries({ queryKey: FIELDS_KEY })
      const previous = queryClient.getQueryData<Schemas['FieldPage']>(FIELDS_KEY)
      if (previous) {
        queryClient.setQueryData<Schemas['FieldPage']>(FIELDS_KEY, {
          ...previous,
          items: previous.items.map((field) => (field.id === id ? { ...field, auto_fill: autoFill } : field)),
        })
      }
      return { previous }
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(FIELDS_KEY, context.previous)
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: FIELDS_KEY }),
  })
}

export function useDeleteField() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => unwrap(api.DELETE('/api/v1/fields/{field_id}', { params: { path: { field_id: id } } })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: FIELDS_KEY }),
  })
}

/** The navigation `state` that carries a request from the summary chat to the draft of the agenda type instructions. */
export interface InstructionsRequestState {
  instructionsRequest: string
}

export function useAgendaTypes() {
  return useQuery({
    queryKey: AGENDA_TYPES_KEY,
    queryFn: () => unwrap(api.GET('/api/v1/agenda-types', { params: { query: { limit: 200 } } })),
  })
}

/** Creates (without `id`) or edits an agenda type. */
export function useSaveAgendaType() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, draft }: { id: string | null; draft: AgendaTypeDraft }) =>
      id
        ? unwrap(
            api.PATCH('/api/v1/agenda-types/{agenda_type_id}', {
              params: { path: { agenda_type_id: id } },
              body: draft,
            }),
          )
        : unwrap(api.POST('/api/v1/agenda-types', { body: draft })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: AGENDA_TYPES_KEY }),
  })
}

export function useDeleteAgendaType() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      unwrap(api.DELETE('/api/v1/agenda-types/{agenda_type_id}', { params: { path: { agenda_type_id: id } } })),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: AGENDA_TYPES_KEY })
      // The recordings of this agenda type are left without one.
      queryClient.invalidateQueries({ queryKey: ['recordings'] })
    },
  })
}

/** Tests the rule of a draft field; without `recording_ids`, on the 3 most recent transcribed recordings. */
export function startFieldPreview(body: Schemas['FieldPreviewRequest']): Promise<Preview> {
  return unwrap(api.POST('/api/v1/fields/preview', { body }))
}

/** Previews a draft agenda type on a transcribed recording. */
export function startAgendaTypePreview(body: Schemas['AgendaTypePreviewRequest']): Promise<Preview> {
  return unwrap(api.POST('/api/v1/agenda-types/preview', { body }))
}
