// The Agent: conversations stored on the server (/agent/sessions), attachments and generated files. A
// question returns 202 with the question stored and the answer queued, and the screen polls the answer
// until `done` or `failed`. The history is the server's conversation: the client resends nothing. A
// question may pick a skill, and the answer may carry action proposals, which the person confirms or
// discards on the card and the screen polls until they finish (holetz/eclume#145).
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

/** The confirmed action still running. */
export const isRunning = (action: Pick<AgentAction, 'status'> | undefined) =>
  action?.status === 'queued' || action?.status === 'running'

/** The URL of the file content: same origin, with the session by cookie. */
export const fileUrl = (file: Pick<AgentFile, 'id'>) => `/api/v1/agent/files/${file.id}/content`

export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`
}

/** The recent conversations, for the list beside the conversation. */
export function useRecentSessions() {
  return useQuery({
    queryKey: [...sessionsKey, 'recent'],
    queryFn: () => unwrap(api.GET('/api/v1/agent/sessions', { params: { query: { limit: RECENT } } })),
  })
}

/** All conversations, paged (the Conversas page). */
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
    // Answers arrive through each message's polling and the screen's changes already update the
    // cache; rereading the conversation on every mount would only risk erasing the question just sent.
    staleTime: 60_000,
    retry: false,
  })
}

/** One answer: polls while it is queued or running. */
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
      // Once ready, the conversation gains the answer and the list moves the conversation up.
      if (!isActive(fresh)) void queryClient.invalidateQueries({ queryKey: sessionsKey })
      return fresh
    },
    initialData: message,
    // Ready from the start, there is nothing to poll.
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
      // The new conversation is born in the cache, empty: the screen need not fetch it.
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

/** One action proposal: polls while the confirmed run is queued or running. */
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
      // Once confirmed, polling restarts until the run finishes.
      if (isRunning(action)) void queryClient.invalidateQueries({ queryKey: actionKey(action.id) })
    },
  })
}

