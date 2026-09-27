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

/** Grava ou apaga um segredo da plataforma (só escrita); a lista se relê em seguida. */
export function usePlatformSecret(name: string) {
  const queryClient = useQueryClient()
  const path = { params: { path: { secret_name: name } } }
  const refresh = () => queryClient.invalidateQueries({ queryKey: SECRETS_KEY })
  return {
    save: useMutation({
      mutationFn: (value: string) =>
        unwrap(api.PUT('/api/v1/admin/secrets/{secret_name}', { ...path, body: { value } })),
      onSuccess: refresh,
    }),
    clear: useMutation({
      mutationFn: () => unwrap(api.DELETE('/api/v1/admin/secrets/{secret_name}', path)),
      onSuccess: refresh,
    }),
  }
}

// A busca de usuários filtra a lista já carregada: o contrato não tem `q`, e são poucas contas.
const MAX_USER_PAGES = 20

/** Todas as contas de usuário, seguindo `next_cursor` até o fim (com teto de páginas). */
export function useAllUsers() {
  return useQuery({
    queryKey: USERS_KEY,
    queryFn: async () => {
      const users: Schemas['AdminUser'][] = []
      let cursor: string | undefined
      for (let page = 0; page < MAX_USER_PAGES; page++) {
        const data = await unwrap(api.GET('/api/v1/admin/users', { params: { query: { limit: 200, cursor } } }))
        users.push(...data.items)
        if (!data.next_cursor) break
        cursor = data.next_cursor
      }
      return users
    },
  })
}

/** Ativa ou desativa uma conta e troca a linha no cache pela resposta. */
export function useSetUserActive() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      unwrap(api.PATCH('/api/v1/admin/users/{user_id}', { params: { path: { user_id: id } }, body: { active } })),
    onSuccess: (updated) =>
      queryClient.setQueryData<Schemas['AdminUser'][]>(USERS_KEY, (users) =>
        users?.map((user) => (user.id === updated.id ? updated : user)),
      ),
  })
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
