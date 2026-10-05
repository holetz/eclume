// O Agente: conversas guardadas no servidor (/agent/sessions), anexos e arquivos gerados. A pergunta
// devolve 202 com a pergunta gravada e a resposta na fila, e a tela consulta a resposta até `done`
// ou `failed`. O histórico é o da conversa no servidor: o cliente não reenvia nada. A pergunta pode
// escolher uma habilidade, e a resposta pode trazer propostas de ação, que a pessoa confirma ou descarta
// no cartão e a tela consulta até terminar (holetz/eclume#145).
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Schemas } from '../../api/client'
import { unwrap } from '../../api/problem'
import { pollWhile } from '../../app/polling'

export type AgentSession = Schemas['AgentSession']
export type AgentSessionDetail = Schemas['AgentSessionDetail']
export type AgentMessage = Schemas['AgentMessage']
export type AgentFile = Schemas['AgentFile']
export type AgentAction = Schemas['AgentAction']

export const AGENT_POLL_MS = 2000
export const MAX_QUESTION = 4000
export const MAX_ATTACHMENTS = 5
export const MAX_FILE_BYTES = 10 * 1024 * 1024
export const ACCEPTED_FILES = '.txt,.md,.csv,.pdf,.docx'
export const UNTITLED = 'Conversa sem título'
const RECENT = 20
const PAGE = 25

export const AGENT_KEY = ['agent'] as const
export const sessionsKey = [...AGENT_KEY, 'sessions'] as const
export const sessionKey = (id: string) => [...AGENT_KEY, 'session', id] as const
export const messageKey = (sessionId: string, id: string) => [...AGENT_KEY, 'message', sessionId, id] as const
export const actionKey = (id: string) => [...AGENT_KEY, 'action', id] as const

export const isActive = (message: Pick<AgentMessage, 'status'> | undefined) =>
  message?.status === 'queued' || message?.status === 'running'

/** A ação confirmada ainda executando. */
export const isRunning = (action: Pick<AgentAction, 'status'> | undefined) =>
  action?.status === 'queued' || action?.status === 'running'

/** O endereço do conteúdo do arquivo: a mesma origem, com a sessão por cookie. */
export const fileUrl = (file: Pick<AgentFile, 'id'>) => `/api/v1/agent/files/${file.id}/content`

export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`
}

/** As conversas recentes, para a lista ao lado da conversa. */
export function useRecentSessions() {
  return useQuery({
    queryKey: [...sessionsKey, 'recent'],
    queryFn: () => unwrap(api.GET('/api/v1/agent/sessions', { params: { query: { limit: RECENT } } })),
  })
}

/** Todas as conversas, por página (a página Conversas). */
export function useAllSessions() {
  return useInfiniteQuery({
    queryKey: [...sessionsKey, 'all'],
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/api/v1/agent/sessions', {
          params: { query: { limit: PAGE, ...(pageParam ? { cursor: pageParam } : {}) } },
        }),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
  })
}

export function useAgentSession(id: string | undefined) {
  return useQuery({
    queryKey: sessionKey(id ?? ''),
    queryFn: () =>
      unwrap(api.GET('/api/v1/agent/sessions/{session_id}', { params: { path: { session_id: id ?? '' } } })),
    enabled: Boolean(id),
    // As respostas chegam pelas consultas de cada mensagem e as mudanças da tela já atualizam o
    // cache; reler a conversa a cada montagem só arriscaria apagar a pergunta recém-enviada.
    staleTime: 60_000,
    retry: false,
  })
}

/** Uma resposta: consulta enquanto está na fila ou rodando. */
export function useAgentMessage(message: AgentMessage) {
  const queryClient = useQueryClient()
  return useQuery({
    queryKey: messageKey(message.session_id, message.id),
    queryFn: async () => {
      const fresh = await unwrap(
        api.GET('/api/v1/agent/sessions/{session_id}/messages/{message_id}', {
          params: { path: { session_id: message.session_id, message_id: message.id } },
        }),
      )
      // Pronta, a conversa ganha a resposta e a lista sobe a conversa.
      if (!isActive(fresh)) void queryClient.invalidateQueries({ queryKey: sessionsKey })
      return fresh
    },
    initialData: message,
    // Pronta desde o começo, não há o que consultar.
    staleTime: isActive(message) ? 0 : Infinity,
    retry: false,
    refetchInterval: pollWhile((data: AgentMessage | undefined) => isActive(data), AGENT_POLL_MS),
  })
}

export function useCreateSession() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (title: string = '') => unwrap(api.POST('/api/v1/agent/sessions', { body: { title } })),
    onSuccess: (session) => {
      // A conversa nova já nasce no cache, vazia: a tela não precisa buscá-la.
      queryClient.setQueryData<AgentSessionDetail>(sessionKey(session.id), { ...session, messages: [], pending_files: [] })
      void queryClient.invalidateQueries({ queryKey: sessionsKey })
    },
  })
}

export function useRenameSession() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      unwrap(api.PATCH('/api/v1/agent/sessions/{session_id}', { params: { path: { session_id: id } }, body: { title } })),
    onSuccess: (session) => {
      void queryClient.invalidateQueries({ queryKey: sessionsKey })
      queryClient.setQueryData<AgentSessionDetail>(sessionKey(session.id), (current) =>
        current ? { ...current, title: session.title } : current,
      )
    },
  })
}

export function useDeleteSession() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      await unwrap(api.DELETE('/api/v1/agent/sessions/{session_id}', { params: { path: { session_id: id } } }))
      return id
    },
    onSuccess: (id) => {
      queryClient.removeQueries({ queryKey: sessionKey(id) })
      void queryClient.invalidateQueries({ queryKey: sessionsKey })
    },
  })
}

export function useAttachFile() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ sessionId, file }: { sessionId: string; file: File }) => {
      const form = new FormData()
      form.append('file', file, file.name)
      return unwrap(
        api.POST('/api/v1/agent/sessions/{session_id}/files', {
          params: { path: { session_id: sessionId } },
          body: form as unknown as { file: string },
          bodySerializer: (body) => body as unknown as FormData,
        }),
      )
    },
    onSuccess: (file) =>
      queryClient.setQueryData<AgentSessionDetail>(sessionKey(file.session_id), (current) =>
        current ? { ...current, pending_files: [...current.pending_files, file] } : current,
      ),
  })
}

export function useRemoveFile() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (file: AgentFile) => {
      await unwrap(
        api.DELETE('/api/v1/agent/sessions/{session_id}/files/{file_id}', {
          params: { path: { session_id: file.session_id, file_id: file.id } },
        }),
      )
      return file
    },
    onSuccess: (file) =>
      queryClient.setQueryData<AgentSessionDetail>(sessionKey(file.session_id), (current) =>
        current ? { ...current, pending_files: current.pending_files.filter((item) => item.id !== file.id) } : current,
      ),
  })
}

export function useAskAgent() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      sessionId,
      message,
      attachments,
      skill,
    }: {
      sessionId: string
      message: string
      attachments: string[]
      skill?: string
    }) =>
      unwrap(
        api.POST('/api/v1/agent/sessions/{session_id}/messages', {
          params: { path: { session_id: sessionId } },
          body: { message, attachments, ...(skill ? { skill } : {}) },
        }),
      ),
    onSuccess: (turn, { sessionId }) => {
      const sent = new Set(turn.question.files.map((file) => file.id))
      queryClient.setQueryData<AgentSessionDetail>(sessionKey(sessionId), (current) =>
        current
          ? {
              ...current,
              title: current.title || turn.question.content.slice(0, 120),
              messages: [...current.messages, turn.question, turn.answer],
              pending_files: current.pending_files.filter((file) => !sent.has(file.id)),
            }
          : current,
      )
      void queryClient.invalidateQueries({ queryKey: sessionsKey })
    },
  })
}

/** Uma proposta de ação: consulta enquanto a execução confirmada está na fila ou rodando. */
export function useAgentAction(action: AgentAction) {
  return useQuery({
    queryKey: actionKey(action.id),
    queryFn: () => unwrap(api.GET('/api/v1/agent/actions/{action_id}', { params: { path: { action_id: action.id } } })),
    initialData: action,
    staleTime: isRunning(action) ? 0 : Infinity,
    retry: false,
    refetchInterval: pollWhile((data: AgentAction | undefined) => isRunning(data), AGENT_POLL_MS),
  })
}

export function useDecideAction() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'confirm' | 'cancel' }) =>
      decision === 'confirm'
        ? unwrap(api.POST('/api/v1/agent/actions/{action_id}/confirm', { params: { path: { action_id: id } } }))
        : unwrap(api.POST('/api/v1/agent/actions/{action_id}/cancel', { params: { path: { action_id: id } } })),
    onSuccess: (action) => {
      queryClient.setQueryData<AgentAction>(actionKey(action.id), action)
      // Confirmada, a consulta recomeça até a execução terminar.
      if (isRunning(action)) void queryClient.invalidateQueries({ queryKey: actionKey(action.id) })
    },
  })
}

