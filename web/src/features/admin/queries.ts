// Estado de servidor da área Administração. Mutações gravam no cache o que a resposta devolve.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Schemas } from '../../api/client'
import { unwrap } from '../../api/problem'

export const SETTINGS_KEY = ['admin', 'settings'] as const
export const PROVIDERS_KEY = ['admin', 'agent-providers'] as const
export const SECRETS_KEY = ['admin', 'secrets'] as const
export const USERS_KEY = ['admin', 'users'] as const
export const HEALTH_KEY = ['admin', 'health'] as const

export const HEALTH_REFRESH_MS = 10_000
// As listas do painel são curtas (uma instalação): uma página grande basta.
const PAGE = { params: { query: { limit: 200 } } } as const

export function useAdminSettings() {
  return useQuery({ queryKey: SETTINGS_KEY, queryFn: () => unwrap(api.GET('/api/v1/admin/settings')) })
}

export function useUpdateSettings() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: Schemas['AdminSettingsPatch']) => unwrap(api.PATCH('/api/v1/admin/settings', { body })),
    onSuccess: (settings) => queryClient.setQueryData(SETTINGS_KEY, settings),
  })
}

export function useProviders() {
  return useQuery({
    queryKey: PROVIDERS_KEY,
    queryFn: () => unwrap(api.GET('/api/v1/admin/agent-providers')),
  })
}

export function useSecrets() {
  return useQuery({ queryKey: SECRETS_KEY, queryFn: () => unwrap(api.GET('/api/v1/admin/secrets')) })
}

export function useUsers() {
  return useQuery({ queryKey: USERS_KEY, queryFn: () => unwrap(api.GET('/api/v1/admin/users', PAGE)) })
}

/** Retenta o job que falhou (a revisão seguinte da gravação); a Saúde se atualiza em seguida. */
export function useRetryJob() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (jobId: string) =>
      unwrap(api.POST('/api/v1/admin/jobs/{job_id}/retry', { params: { path: { job_id: jobId } } })),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: HEALTH_KEY }),
  })
}

export function useAdminHealth() {
  return useQuery({
    queryKey: HEALTH_KEY,
    queryFn: () => unwrap(api.GET('/api/v1/admin/health')),
    refetchInterval: HEALTH_REFRESH_MS,
    staleTime: 0,
  })
}
