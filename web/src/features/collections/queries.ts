// Coleções do usuário. Poucas por usuário: uma página de 200 cobre a tela inteira.
import { useQuery } from '@tanstack/react-query'
import { api, type Schemas } from '../../api/client'
import { unwrap } from '../../api/problem'

export type Collection = Schemas['Collection']

export const COLLECTIONS_KEY = ['collections'] as const

export function useCollections() {
  return useQuery({
    queryKey: COLLECTIONS_KEY,
    queryFn: () => unwrap(api.GET('/api/v1/collections', { params: { query: { limit: 200 } } })),
  })
}
