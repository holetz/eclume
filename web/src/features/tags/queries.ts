// Cadastro de tags do usuário e como o agente as atribui. Poucas por usuário (o teto do cadastro é
// 200): a lista inteira cabe numa resposta só.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Schemas } from '../../api/client'
import { unwrap } from '../../api/problem'

export type Tag = Schemas['Tag']
export type TagAssignment = Schemas['TagAssignment']

export const TAGS_KEY = ['tags'] as const
const TAG_ASSIGNMENT_KEY = ['me', 'tag-assignment'] as const

/** O cadastro, em ordem alfabética; o filtro da biblioteca e da busca também lê daqui. */
export function useTags() {
  return useQuery({ queryKey: TAGS_KEY, queryFn: () => unwrap(api.GET('/api/v1/tags')) })
}

/** A configuração do agente: automático, regra geral, modo e limite, com o tamanho do cadastro. */
export function useTagAssignment() {
  return useQuery({
    queryKey: TAG_ASSIGNMENT_KEY,
    queryFn: () => unwrap(api.GET('/api/v1/me/tag-assignment')),
  })
}

export function useUpdateTagAssignment() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: Schemas['TagAssignmentPatch']) => unwrap(api.PATCH('/api/v1/me/tag-assignment', { body })),
    onSuccess: (updated) => queryClient.setQueryData(TAG_ASSIGNMENT_KEY, updated),
  })
}

/**
 * Atualiza o que muda com o cadastro: a lista, o tamanho dele (mostrado no cartão) e os tipos de
 * agenda, que levam tags padrão. Renomear, mesclar e excluir também mexem nas gravações, abertas ou
 * nas listas.
 */
export function useRefreshTags() {
  const queryClient = useQueryClient()
  return (recordings: boolean) => {
    void queryClient.invalidateQueries({ queryKey: TAGS_KEY })
    void queryClient.invalidateQueries({ queryKey: TAG_ASSIGNMENT_KEY })
    void queryClient.invalidateQueries({ queryKey: ['agenda-types'] })
    if (recordings) {
      void queryClient.invalidateQueries({ queryKey: ['recordings'] })
      void queryClient.invalidateQueries({ queryKey: ['recording'] })
    }
  }
}
