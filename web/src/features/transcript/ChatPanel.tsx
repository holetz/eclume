import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import type { InstructionsRequestState } from '../organize/queries'
import { ApiError, errorMessage } from '../../api/problem'
import { isOpen, MAX_MESSAGE, readNote, useChat, useChatReply, useSendChat, type ChatMessage } from './chat'
import styles from './RecordingPage.module.css'

function AgentMessage({ message, onRetry }: { message: ChatMessage; onRetry: () => void }) {
  const { t } = useTranslation(['transcript', 'common'])
  return (
    <div className="msg msg-agent">
      {/* i18n-ignore: the brand */}
      <span className="msg-who">eclume</span>
      {message.reads.map((read, index) => (
        <span key={index} className="msg-note">
          {readNote(read)}
        </span>
      ))}
      {isOpen(message) ? (
        <span className={styles.working} aria-label={t('chat.working')}>
          {t('chat.working')}
        </span>
      ) : message.status === 'failed' ? (
        <span className={styles.chatError}>
          {message.error?.message ?? t('chat.failed')}{' '}
          <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>
            {t('common:retry')}
          </button>
        </span>
      ) : (
        <>
          {message.content && <span>{message.content}</span>}
          {message.error?.code === 'summary_changed' && <span className="msg-note">{t('chat.changed')}</span>}
        </>
      )}
    </div>
  )
}

interface ChatPanelProps {
  recordingId: string
  /** With no transcript, there is no history to read (the API answers 409). */
  hasTranscript: boolean
  /** There is a current summary: without it, the chat has nothing to work on. */
  hasSummary: boolean
  /** The recording's agenda type: after an adjustment, the request can go to its instructions. */
  agendaTypeId?: string | null
  className?: string
}

/** The `aside.chat` "Ajustar o resumo": history, transcript reading notes and the composer. */
export function ChatPanel({ recordingId, hasTranscript, hasSummary, agendaTypeId = null, className = '' }: ChatPanelProps) {
  const { t } = useTranslation('transcript')
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
  // The last adjustment that changed the summary: its request can become a rule of the agenda type.
  const lastAdjustment = messages.findLast(
    (message) => message.role === 'assistant' && message.status === 'done' && message.summary_id !== null,
  )
  const adjustmentRequest = lastAdjustment ? request(lastAdjustment) : ''

  return (
    <aside className={`chat ${className}`} aria-label={t('chat.title')}>
      <div className="chat-head">
        <strong>{t('chat.title')}</strong>
        <span className={`text-muted ${styles.chatSub}`}>
          {t('chat.sub')}
        </span>
      </div>
      <div ref={logRef} className="chat-log" role="log" aria-live="polite" aria-label={t('chat.log')}>
        {chat.isError && (
          <p className="alert alert-error" role="alert">
            {errorMessage(chat.error)}
          </p>
        )}
        {messages.map((message) =>
          message.role === 'user' ? (
            <div key={message.id} className="msg msg-user">
              <span className="msg-who">{t('chat.you')}</span>
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
            {t('chat.toInstructions')}
          </Link>
        )}
      </div>
      <form className="composer" onSubmit={onSubmit}>
        <label htmlFor={fieldId} className="visually-hidden">
          {t('chat.requestLabel')}
        </label>
        <textarea
          id={fieldId}
          className="input"
          placeholder={t('chat.placeholder')}
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
        {!hasSummary && <p className={styles.chatSub}>{t('chat.unavailable')}</p>}
        {busy && hasSummary && <p className={styles.chatSub}>{t('chat.busy')}</p>}
        {send.isError && !(send.error instanceof ApiError && send.error.code === 'chat_busy') && (
          <p className="alert alert-error" role="alert">
            {errorMessage(send.error)}
          </p>
        )}
        <div className="composer-row">
          <span>{t('chat.versions')}</span>
          <button type="submit" className="btn btn-primary btn-sm" disabled={disabled || !text.trim()}>
            {t('chat.send')}
          </button>
        </div>
      </form>
    </aside>
  )
}
