// O chat sobre a base: o POST devolve 202 com a pergunta na fila, e a tela consulta
// GET /base-chat/{id} até `done` ou `failed`. O servidor não guarda a conversa: o cliente reenvia as
// últimas mensagens (até 10) a cada pergunta. O estado do pedido vive 1 h no servidor (404 = expirou).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Schemas } from '../../api/client'
import { unwrap } from '../../api/problem'
import { pollWhile } from '../../app/polling'

export type BaseChat = Schemas['BaseChat']
type Turn = Schemas['BaseChatTurn']

export const BASE_CHAT_POLL_MS = 2000
export const MAX_QUESTION = 4000
const MAX_HISTORY = 10

export const baseChatKey = (id: string) => ['base-chat', id] as const

export const isActive = (chat: Pick<BaseChat, 'status'> | undefined) =>
  chat?.status === 'queued' || chat?.status === 'running'

/** Um item da conversa na tela: a pergunta, ou a resposta (o pedido cujo estado a tela consulta). */
export type Entry = { kind: 'question'; key: string; text: string } | { kind: 'answer'; key: string; chatId: string }

export function useBaseChat(id: string) {
  return useQuery({
    queryKey: baseChatKey(id),
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/base-chat/{chat_id}', {
          params: { path: { chat_id: id } },
        }),
      ),
    retry: false,
    refetchInterval: pollWhile((data: BaseChat | undefined) => isActive(data), BASE_CHAT_POLL_MS),
  })
}

/** As últimas mensagens da conversa que o servidor precisa: perguntas e respostas prontas. */
export function historyOf(entries: Entry[], read: (chatId: string) => BaseChat | undefined): Turn[] {
  const turns: Turn[] = []
  for (const entry of entries) {
    if (entry.kind === 'question') turns.push({ role: 'user', content: entry.text })
    else {
      const answer = read(entry.chatId)?.answer
      if (answer) turns.push({ role: 'assistant', content: answer })
    }
  }
  return turns.slice(-MAX_HISTORY)
}

export function useAskBaseChat() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: { message: string; history: Turn[] }) => unwrap(api.POST('/api/v1/base-chat', { body })),
    onSuccess: (chat) => queryClient.setQueryData(baseChatKey(chat.id), chat),
  })
}
