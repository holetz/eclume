// Campos do usuário e tipos de agenda (Organizar), com as pré-visualizações que testam um rascunho
// sem gravar nada. Poucos por usuário: uma página cobre a tela inteira.
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

/** O rascunho de um campo no formato do contrato: nome sem espaços nas pontas, e só a Escolha leva opções. */
export function cleanDraft(draft: FieldDraft): FieldDraft {
  return { ...draft, name: draft.name.trim(), options: draft.kind === 'choice' ? draft.options : [] }
}

/** Os erros 422 do contrato por campo do formulário (`name`, `options`; `field.name` e `agenda_type.name` nas pré-visualizações). */
export function invalidFields(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError) || error.problem?.code !== 'validation_failed') return {}
  const byField: Record<string, string> = {}
  for (const { field, message } of error.problem.errors ?? []) {
    byField[field.replace(/^(field|agenda_type)\./, '').replace(/\[\d+\]$/, '')] = message
  }
  return byField
}

export const FIELDS_KEY = ['fields'] as const
// A mesma chave (e a mesma página) que o painel de resumos da gravação usa.
export const AGENDA_TYPES_KEY = ['agenda-types'] as const

export function useFields() {
  return useQuery({ queryKey: FIELDS_KEY, queryFn: () => unwrap(api.GET('/api/v1/fields')) })
}

/** Cria (sem `id`) ou edita um campo. */
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

/** O liga-desliga "Automático" da lista: otimista, e volta ao valor anterior se o servidor recusar. */
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

export function useAgendaTypes() {
  return useQuery({
    queryKey: AGENDA_TYPES_KEY,
    queryFn: () => unwrap(api.GET('/api/v1/agenda-types', { params: { query: { limit: 100 } } })),
  })
}

/** Cria (sem `id`) ou edita um tipo de agenda. */
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
      // As gravações deste tipo ficam sem tipo.
      queryClient.invalidateQueries({ queryKey: ['recordings'] })
    },
  })
}

/** Testa a regra de um campo em rascunho; sem `recording_ids`, nas 3 gravações transcritas mais recentes. */
export function startFieldPreview(body: Schemas['FieldPreviewRequest']): Promise<Preview> {
  return unwrap(api.POST('/api/v1/fields/preview', { body }))
}

/** Pré-visualiza um tipo de agenda em rascunho numa gravação transcrita. */
export function startAgendaTypePreview(body: Schemas['AgendaTypePreviewRequest']): Promise<Preview> {
  return unwrap(api.POST('/api/v1/agenda-types/preview', { body }))
}
