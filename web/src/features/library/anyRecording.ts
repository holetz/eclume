// A pergunta "a conta tem alguma gravação?", num módulo próprio: o shell a faz em toda tela (o
// destaque do Agente) sem puxar as consultas da biblioteca para o JS inicial.
import { useQuery } from '@tanstack/react-query'
import { api } from '../../api/client'
import { unwrap } from '../../api/problem'

/** Se a conta tem alguma gravação; `enabled` adia a consulta até alguém precisar dela. */
export function useHasAnyRecording(enabled = true) {
  return useQuery({
    queryKey: ['recordings', 'any'],
    enabled,
    queryFn: () => unwrap(api.GET('/api/v1/recordings', { params: { query: { limit: 1 } } })),
    select: (page) => page.items.length > 0,
  })
}
