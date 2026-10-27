// The "Ajustar o resumo" chat: the recording history, the send (202 with the request and the response queued)
// and polling the response until it finishes. The agent works on the summary and each change becomes a version.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { api, type Schemas } from '../../api/client'
import { ApiError, unwrap } from '../../api/problem'
import { pollWhile } from '../../app/polling'
import { hms } from './markers'
import { chatKey, summaryKey } from './queries'

export type ChatMessage = Schemas['SummaryChatMessage']
type ChatPage = Schemas['SummaryChatPage']

const POLL_MS = 2000
export const MAX_MESSAGE = 4000

export function isOpen(message: Pick<ChatMessage, 'status'>): boolean {
  return message.status === 'queued' || message.status === 'running'
}

/** "Leu a transcrição, 00:03:20–00:04:20 (cortado)" or "Buscou “orçamento” na transcrição · 3 trechos". */
export function readNote(read: Schemas['ChatRead']): string {
  if (read.tool === 'search_transcript') {
    const hits = read.hits ?? 0
    return `Buscou “${read.query ?? ''}” na transcrição · ${hits === 1 ? '1 trecho' : `${hits} trechos`}`
  }
  const range = `${hms(read.from_ms ?? 0)}–${hms(read.to_ms ?? 0)}`
  return `Leu a transcrição, ${range}${read.clipped ? ' (cortado)' : ''}`
}

export function useChat(recordingId: string, enabled = true) {
  return useQuery({
    queryKey: chatKey(recordingId),
    enabled,
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/recordings/{recording_id}/summary/chat', {
          params: { path: { recording_id: recordingId }, query: { limit: 200 } },
        }),
      ),
    refetchOnWindowFocus: true,
  })
}

/** Replaces or appends messages in the cached history. */
function merge(page: ChatPage | undefined, messages: ChatMessage[]): ChatPage | undefined {
  if (!page) return page
  const items = [...page.items]
  for (const message of messages) {
    const index = items.findIndex((item) => item.id === message.id)
    if (index === -1) items.push(message)
    else items[index] = message
  }
  return { ...page, items }
}

export function useSendChat(recordingId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (message: string) =>
      unwrap(
        api.POST('/api/v1/recordings/{recording_id}/summary/chat', {
          params: { path: { recording_id: recordingId } },
          body: { message },
        }),
      ),
    onSuccess: (exchange) =>
      queryClient.setQueryData<ChatPage>(chatKey(recordingId), (page) =>
        merge(page, [exchange.message, exchange.reply]),
      ),
    // Another open request (in another tab, for example): rereads the history to follow it.
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'chat_busy')
        void queryClient.invalidateQueries({ queryKey: chatKey(recordingId) })
    },
  })
}

/**
 * Polls the open response every 2 s until `done` or `failed`, updating the history. When the
 * response created a version, rereads the summary.
 */
export function useChatReply(recordingId: string, messageId: string | null) {
  const queryClient = useQueryClient()
  const reply = useQuery({
    queryKey: ['summary-chat-message', messageId],
    enabled: messageId !== null,
    queryFn: () =>
      unwrap(api.GET('/api/v1/summary-chat-messages/{message_id}', { params: { path: { message_id: messageId! } } })),
    refetchInterval: pollWhile((data: ChatMessage | undefined) => !data || isOpen(data), POLL_MS),
  })
  const data = reply.data
  useEffect(() => {
    if (!data) return
    queryClient.setQueryData<ChatPage>(chatKey(recordingId), (page) => merge(page, [data]))
    if (data.status === 'done' && data.summary_id) {
      void queryClient.invalidateQueries({ queryKey: summaryKey(recordingId) })
    }
  }, [data, queryClient, recordingId])
}
