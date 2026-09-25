import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { api, type Schemas } from '../api/client'
import { ApiError, type Problem } from '../api/problem'

export type Me = Schemas['Me']

export const ME_KEY = ['me'] as const

/** Usuário da sessão, ou `null` sem sessão (401). */
async function fetchMe(): Promise<Me | null> {
  const { data, error, response } = await api.GET('/api/v1/me')
  if (response.status === 401) return null
  if (!data) throw new ApiError(response.status, (error as Problem | undefined) ?? null)
  return data
}

export function useMe() {
  return useQuery({ queryKey: ME_KEY, queryFn: fetchMe, staleTime: 60_000 })
}

/** Caminho interno seguro para voltar depois do login; qualquer outra coisa volta ao início. */
export function safeReturnPath(value: string | null): string {
  return value && value.startsWith('/') && !value.startsWith('//') ? value : '/'
}

export function useLogout() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  return useMutation({
    mutationFn: async () => {
      const { response } = await api.POST('/api/v1/auth/logout')
      // Sessão já expirada também é saída.
      if (!response.ok && response.status !== 401) throw new ApiError(response.status, null)
    },
    onSuccess: () => {
      queryClient.removeQueries()
      queryClient.setQueryData(ME_KEY, null)
      navigate('/entrar', { replace: true })
    },
  })
}
