// Estado de servidor da área Administração. Mutações gravam no cache o que a resposta devolve.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Schemas } from '../../api/client'
import { unwrap } from '../../api/problem'

const SETTINGS_KEY = ['admin', 'settings'] as const
export const PROVIDERS_KEY = ['admin', 'agent-providers'] as const
const SECRETS_KEY = ['admin', 'secrets'] as const
const USERS_KEY = ['admin', 'users'] as const
const HEALTH_KEY = ['admin', 'health'] as const
const DEFAULT_TYPES_KEY = ['admin', 'default-agenda-types'] as const

// Alinhado ao heartbeat de 15 s do worker GPU.
export const HEALTH_REFRESH_MS = 15_000

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

/** Gera o link de redefinição de senha da conta; a URL só volta nesta resposta. */
export function useCreatePasswordReset() {
  return useMutation({
    mutationFn: (id: string) =>
      unwrap(api.POST('/api/v1/admin/users/{user_id}/password-reset', { params: { path: { user_id: id } } })),
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
    refetchIntervalInBackground: false,
    staleTime: 0,
  })
}

type DefaultAgendaType = Schemas['DefaultAgendaType']

/** Os tipos de agenda padrão, na ordem de `position`. */
export function useDefaultAgendaTypes() {
  return useQuery({
    queryKey: DEFAULT_TYPES_KEY,
    queryFn: async () => {
      const page = await unwrap(api.GET('/api/v1/admin/default-agenda-types'))
      return [...page.items].sort((a, b) => a.position - b.position)
    },
  })
}

const replaceType = (updated: DefaultAgendaType) => (types: DefaultAgendaType[] | undefined) =>
  types?.map((type) => (type.id === updated.id ? updated : type))

/** Cria (sem `id`) ou edita um tipo padrão; a resposta entra no cache. */
export function useSaveDefaultAgendaType() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string | null; body: Schemas['DefaultAgendaTypePatch'] }) =>
      id === null
        ? unwrap(api.POST('/api/v1/admin/default-agenda-types', { body: body as Schemas['DefaultAgendaTypeCreate'] }))
        : unwrap(
            api.PATCH('/api/v1/admin/default-agenda-types/{agenda_type_id}', {
              params: { path: { agenda_type_id: id } },
              body,
            }),
          ),
    onSuccess: (saved, { id }) =>
      queryClient.setQueryData<DefaultAgendaType[]>(DEFAULT_TYPES_KEY, (types) =>
        id === null ? [...(types ?? []), saved] : replaceType(saved)(types),
      ),
  })
}

/** "Incluir para novos usuários" na hora: otimista, e volta atrás se o servidor recusar. */
export function useToggleDefaultAgendaType() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, include }: { id: string; include: boolean }) =>
      unwrap(
        api.PATCH('/api/v1/admin/default-agenda-types/{agenda_type_id}', {
          params: { path: { agenda_type_id: id } },
          body: { include_for_new_users: include },
        }),
      ),
    onMutate: async ({ id, include }) => {
      await queryClient.cancelQueries({ queryKey: DEFAULT_TYPES_KEY })
      const before = queryClient.getQueryData<DefaultAgendaType[]>(DEFAULT_TYPES_KEY)
      queryClient.setQueryData<DefaultAgendaType[]>(DEFAULT_TYPES_KEY, (types) =>
        types?.map((type) => (type.id === id ? { ...type, include_for_new_users: include } : type)),
      )
      return { before }
    },
    onError: (_error, _vars, context) => queryClient.setQueryData(DEFAULT_TYPES_KEY, context?.before),
    onSuccess: (saved) => queryClient.setQueryData<DefaultAgendaType[]>(DEFAULT_TYPES_KEY, replaceType(saved)),
  })
}

export function useDeleteDefaultAgendaType() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      unwrap(api.DELETE('/api/v1/admin/default-agenda-types/{agenda_type_id}', { params: { path: { agenda_type_id: id } } })),
    onSuccess: (_data, id) =>
      queryClient.setQueryData<DefaultAgendaType[]>(DEFAULT_TYPES_KEY, (types) => types?.filter((type) => type.id !== id)),
  })
}
