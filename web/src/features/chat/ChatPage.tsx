import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import { Link } from 'react-router'
import { ApiError, errorMessage } from '../../api/problem'
import { useHelpTopic } from '../../app/help'
import { SAFE_MARKDOWN } from '../../app/markdown'
import { PageHead } from '../../app/PageHead'
import {
  baseChatKey,
  historyOf,
  isActive,
  MAX_QUESTION,
  useAskBaseChat,
  useBaseChat,
  type BaseChat,
  type Entry,
} from './baseChat'
import styles from './ChatPage.module.css'

const EXAMPLES = [
  'Quais decisões foram tomadas esta semana?',
  'O que ficou combinado com cada cliente sobre prazos?',
  'Quem ficou de enviar algo e até quando?',
]

function queriesNote(chat: BaseChat): string {
  if (chat.queries === 0) return 'Respondeu sem consultar as gravações'
  return chat.queries === 1 ? 'Fez 1 consulta às gravações' : `Fez ${chat.queries} consultas às gravações`
}

function failure(chat: BaseChat): string {
  if (chat.error?.code === 'no_provider') {
    return 'O chat ainda não tem um agente configurado. Peça a quem administra o servidor para habilitar um agente para o chat.'
  }
  return chat.error?.message ?? 'A pergunta falhou.'
}

function Answer({ chatId, onRetry }: { chatId: string; onRetry: () => void }) {
  const query = useBaseChat(chatId)
  const chat = query.data
  const expired = query.error instanceof ApiError && query.error.status === 404
  return (
    <div className="msg msg-agent">
      <span className="msg-who">eclume</span>
      {expired ? (
        <span className={styles.error}>Esta pergunta expirou. Pergunte de novo.</span>
      ) : query.isError ? (
        <span className={styles.error}>{errorMessage(query.error)}</span>
      ) : !chat || isActive(chat) ? (
        <span className={styles.working} aria-label="Consultando as gravações">
          Consultando as gravações
        </span>
      ) : chat.status === 'failed' ? (
        <span className={styles.error}>
          {failure(chat)}{' '}
          <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>
            Tentar de novo
          </button>
        </span>
      ) : (
        <>
          <div className={styles.answer}>
            <ReactMarkdown components={SAFE_MARKDOWN}>{chat.answer ?? ''}</ReactMarkdown>
          </div>
          {chat.sources.length > 0 && (
            <ul className={styles.sources} aria-label="Fontes">
              {chat.sources.map((source) => (
                <li key={source.recording_id}>
                  <Link to={`/gravacoes/${source.recording_id}`}>{source.title}</Link>
                </li>
              ))}
            </ul>
          )}
          <span className="msg-note">{queriesNote(chat)}</span>
        </>
      )}
    </div>
  )
}

/** A tela Perguntas: uma conversa sobre o conjunto das gravações, que prioriza os resumos. */
export function ChatPage() {
  useHelpTopic('perguntas')
  const queryClient = useQueryClient()
  const ask = useAskBaseChat()
  const [entries, setEntries] = useState<Entry[]>([])
  const [text, setText] = useState('')
  const logRef = useRef<HTMLDivElement>(null)
  const fieldId = useId()

  useEffect(() => {
    const log = logRef.current
    if (log) log.scrollTop = log.scrollHeight
  }, [entries.length])

  function submit(message: string) {
    const question = message.trim()
    if (!question || ask.isPending) return
    const history = historyOf(entries, (id) => queryClient.getQueryData<BaseChat>(baseChatKey(id)))
    ask.mutate(
      { message: question, history },
      {
        onSuccess: (chat) => {
          const key = crypto.randomUUID()
          setEntries((current) => [
            ...current,
            { kind: 'question', key: `${key}-q`, text: question },
            { kind: 'answer', key: `${key}-a`, chatId: chat.id },
          ])
          setText('')
        },
      },
    )
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    submit(text)
  }

  // "Tentar de novo" repete a pergunta que veio antes da resposta.
  const questionBefore = (index: number) => {
    const previous = entries[index - 1]
    return previous?.kind === 'question' ? previous.text : ''
  }

  return (
    <div className={styles.page}>
      <PageHead kicker="Gravações" title="Perguntas" />
      <p className={`text-muted ${styles.lead}`}>
        Pergunte sobre o conjunto das suas gravações. O agente começa pelos resumos e só lê as transcrições quando o
        resumo não basta.
      </p>
      <div ref={logRef} className={`chat-log ${styles.log}`} role="log" aria-live="polite" aria-label="Conversa">
        {entries.length === 0 && (
          <div className={styles.examples}>
            <span className="text-muted">Por exemplo:</span>
            {EXAMPLES.map((example) => (
              <button key={example} type="button" className="btn btn-secondary btn-sm" onClick={() => submit(example)}>
                {example}
              </button>
            ))}
          </div>
        )}
        {entries.map((entry, index) =>
          entry.kind === 'question' ? (
            <div key={entry.key} className="msg msg-user">
              <span className="msg-who">Você</span>
              {entry.text}
            </div>
          ) : (
            <Answer key={entry.key} chatId={entry.chatId} onRetry={() => submit(questionBefore(index))} />
          ),
        )}
      </div>
      <form className="composer" onSubmit={onSubmit}>
        <label htmlFor={fieldId} className="visually-hidden">
          Pergunta
        </label>
        <textarea
          id={fieldId}
          className="input"
          placeholder="Pergunte sobre as suas gravações"
          maxLength={MAX_QUESTION}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault()
              submit(text)
            }
          }}
        />
        {ask.isError && (
          <p className="alert alert-error" role="alert">
            {errorMessage(ask.error)}
          </p>
        )}
        <div className="composer-row">
          <span>Ctrl+Enter envia</span>
          <button type="submit" className="btn btn-primary btn-sm" disabled={ask.isPending || !text.trim()}>
            Perguntar
          </button>
        </div>
      </form>
    </div>
  )
}
