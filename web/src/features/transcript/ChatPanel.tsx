import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import type { InstructionsRequestState } from '../organize/queries'
import { ApiError, errorMessage } from '../../api/problem'
import { isOpen, MAX_MESSAGE, readNote, useChat, useChatReply, useSendChat, type ChatMessage } from './chat'
import styles from './RecordingPage.module.css'

const CHANGED_NOTE = 'O resumo mudou enquanto eu trabalhava; nada foi alterado. Peça de novo.'

function AgentMessage({ message, onRetry }: { message: ChatMessage; onRetry: () => void }) {
  return (
    <div className="msg msg-agent">
      <span className="msg-who">eclume</span>
      {message.reads.map((read, index) => (
        <span key={index} className="msg-note">
          {readNote(read)}
        </span>
      ))}
      {isOpen(message) ? (
        <span className={styles.working} aria-label="Trabalhando">
          Trabalhando
        </span>
      ) : message.status === 'failed' ? (
        <span className={styles.chatError}>
          {message.error?.message ?? 'O ajuste falhou.'}{' '}
          <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>
            Tentar de novo
          </button>
        </span>
      ) : (
        <>
          {message.content && <span>{message.content}</span>}
          {message.error?.code === 'summary_changed' && <span className="msg-note">{CHANGED_NOTE}</span>}
        </>
      )}
    </div>
  )
}

interface ChatPanelProps {
  recordingId: string
  /** Sem transcrição, não há histórico a ler (a API responde 409). */
  hasTranscript: boolean
  /** Há resumo atual: sem ele, o chat não tem sobre o que trabalhar. */
  hasSummary: boolean
  /** O tipo de agenda da gravação: depois de um ajuste, o pedido pode ir para as instruções dele. */
  agendaTypeId?: string | null
  className?: string
}

/** O `aside.chat` "Ajustar o resumo": histórico, notas de leitura da transcrição e o composer. */
export function ChatPanel({ recordingId, hasTranscript, hasSummary, agendaTypeId = null, className = '' }: ChatPanelProps) {
  const chat = useChat(recordingId, hasTranscript)
  const send = useSendChat(recordingId)
  const [text, setText] = useState('')
  const logRef = useRef<HTMLDivElement>(null)
  const fieldId = useId()
  const messages = chat.data?.items ?? []
  const open = messages.find((message) => message.role === 'assistant' && isOpen(message)) ?? null
  useChatReply(recordingId, open?.id ?? null)
  const busy = open !== null || (send.error instanceof ApiError && send.error.code === 'chat_busy')
  const disabled = !hasSummary || open !== null || send.isPending

  useEffect(() => {
    const log = logRef.current
    if (log) log.scrollTop = log.scrollHeight
  }, [messages.length, open?.status])

  function submit(message: string) {
    if (!message.trim() || disabled) return
    send.mutate(message.trim(), { onSuccess: () => setText('') })
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    submit(text)
  }

  const request = (reply: ChatMessage) => messages.find((message) => message.id === reply.reply_to)?.content ?? ''
  // O último ajuste que mudou o resumo: o pedido dele pode virar regra do tipo.
  const lastAdjustment = messages.findLast(
    (message) => message.role === 'assistant' && message.status === 'done' && message.summary_id !== null,
  )
  const adjustmentRequest = lastAdjustment ? request(lastAdjustment) : ''

  return (
    <aside className={`chat ${className}`} aria-label="Ajustar o resumo">
      <div className="chat-head">
        <strong>Ajustar o resumo</strong>
        <span className={`text-muted ${styles.chatSub}`}>
          Trabalha sobre o resumo. Só lê a transcrição quando o pedido precisa.
        </span>
      </div>
      <div ref={logRef} className="chat-log" role="log" aria-live="polite" aria-label="Conversa">
        {chat.isError && (
          <p className="alert alert-error" role="alert">
            {errorMessage(chat.error)}
          </p>
        )}
        {messages.map((message) =>
          message.role === 'user' ? (
            <div key={message.id} className="msg msg-user">
              <span className="msg-who">Você</span>
              {message.content}
            </div>
          ) : (
            <AgentMessage key={message.id} message={message} onRetry={() => submit(request(message))} />
          ),
        )}
        {agendaTypeId && adjustmentRequest && (
          <Link
            to={`/config/agendas?tipo=${agendaTypeId}`}
            state={{ instructionsRequest: adjustmentRequest } satisfies InstructionsRequestState}
            className="btn btn-ghost btn-sm"
          >
            Levar este pedido para as instruções do tipo
          </Link>
        )}
      </div>
      <form className="composer" onSubmit={onSubmit}>
        <label htmlFor={fieldId} className="visually-hidden">
          Pedido de ajuste
        </label>
        <textarea
          id={fieldId}
          className="input"
          placeholder="Peça uma mudança, por exemplo: liste as decisões em tabela"
          maxLength={MAX_MESSAGE}
          value={text}
          disabled={!hasSummary}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault()
              submit(text)
            }
          }}
        />
        {!hasSummary && <p className={styles.chatSub}>O chat fica disponível quando houver um resumo.</p>}
        {busy && hasSummary && <p className={styles.chatSub}>Há um pedido em andamento; espere a resposta.</p>}
        {send.isError && !(send.error instanceof ApiError && send.error.code === 'chat_busy') && (
          <p className="alert alert-error" role="alert">
            {errorMessage(send.error)}
          </p>
        )}
        <div className="composer-row">
          <span>Cada mudança vira uma versão</span>
          <button type="submit" className="btn btn-primary btn-sm" disabled={disabled || !text.trim()}>
            Enviar
          </button>
        </div>
      </form>
    </aside>
  )
}
