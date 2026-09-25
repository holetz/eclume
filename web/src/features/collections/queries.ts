// Coleções do usuário e tags em uso. Poucas por usuário: uma página de 200 cobre a tela inteira.
import { useQuery } from '@tanstack/react-query'
import { api, type Schemas } from '../../api/client'
import { unwrap } from '../../api/problem'

export type Collection = Schemas['Collection']

export const COLLECTIONS_KEY = ['collections'] as const
export const TAGS_KEY = ['tags'] as const

export function useCollections(enabled = true) {
  return useQuery({
    queryKey: COLLECTIONS_KEY,
    queryFn: () => unwrap(api.GET('/api/v1/collections', { params: { query: { limit: 200 } } })),
    enabled,
  })
}

export function useTags() {
  return useQuery({ queryKey: TAGS_KEY, queryFn: () => unwrap(api.GET('/api/v1/tags')) })
}
