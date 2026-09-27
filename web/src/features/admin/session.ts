// Sessão da conta de admin, separada da sessão do usuário: cookie próprio (só /api/v1/admin) e
// guarda por `GET /api/v1/admin/me`. Nenhuma credencial de usuário alcança o painel.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { api, type Schemas } from '../../api/client'
import { ApiError, type Problem } from '../../api/problem'

export type AdminAccount = Schemas['AdminAccount']

export const ADMIN_ME_KEY = ['admin', 'me'] as const
export const ADMIN_LOGIN_PATH = '/admin/entrar'

/** Conta de admin da sessão, ou `null` sem sessão de admin (401). */
async function fetchAdminMe(): Promise<AdminAccount | null> {
  const { data, error, response } = await api.GET('/api/v1/admin/me')
  if (response.status === 401) return null
  if (!data) throw new ApiError(response.status, (error as Problem | undefined) ?? null)
  return data
}

export function useAdminMe() {
  return useQuery({ queryKey: ADMIN_ME_KEY, queryFn: fetchAdminMe, staleTime: 60_000 })
}

export function useAdminLogout() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  return useMutation({
    mutationFn: async () => {
      const { response } = await api.POST('/api/v1/admin/auth/logout')
      // Sessão de admin já expirada também é saída.
      if (!response.ok && response.status !== 401) throw new ApiError(response.status, null)
    },
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ['admin'] })
      queryClient.setQueryData(ADMIN_ME_KEY, null)
      navigate(ADMIN_LOGIN_PATH, { replace: true })
    },
  })
}
