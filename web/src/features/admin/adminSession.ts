// The admin account session, separate from the user session: its own cookie (only /api/v1/admin) and
// a guard through `GET /api/v1/admin/me`. The panel never reads the user session (`useMe`).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { api, type Schemas } from '../../api/client'
import { ApiError, unwrap, type Problem } from '../../api/problem'

export type AdminAccount = Schemas['AdminAccount']

export const ADMIN_ME_KEY = ['admin', 'me'] as const
export const ADMIN_LOGIN_PATH = '/admin/entrar'
export const ADMIN_HOME_PATH = '/admin/usuarios'

/** The session's admin account, or `null` without an admin session (401). */
async function fetchAdminMe(): Promise<AdminAccount | null> {
  const { data, error, response } = await api.GET('/api/v1/admin/me')
  if (response.status === 401) return null
  if (!data) throw new ApiError(response.status, (error as Problem | undefined) ?? null)
  return data
}

export function useAdminMe() {
  return useQuery({ queryKey: ADMIN_ME_KEY, queryFn: fetchAdminMe, retry: false, staleTime: 5 * 60_000 })
}

/** Return path inside the panel after login; anything else lands on Usuários. */
export function adminReturnPath(value: string | null): string {
  return value && value.startsWith('/admin/') && !value.startsWith(ADMIN_LOGIN_PATH) ? value : ADMIN_HOME_PATH
}

export function useAdminLogin() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: Schemas['LoginRequest']) => unwrap(api.POST('/api/v1/admin/auth/login', { body })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ADMIN_ME_KEY }),
  })
}

export function useAdminLogout() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  return useMutation({
    mutationFn: async () => {
      const { response } = await api.POST('/api/v1/admin/auth/logout')
      // An already expired admin session is also a sign-out.
      if (!response.ok && response.status !== 401) throw new ApiError(response.status, null)
    },
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ['admin'] })
      queryClient.setQueryData(ADMIN_ME_KEY, null)
      navigate(ADMIN_LOGIN_PATH, { replace: true })
    },
  })
}
