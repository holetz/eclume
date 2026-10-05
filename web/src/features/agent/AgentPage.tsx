import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { FileText, Paperclip, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import { Link, useNavigate, useParams } from 'react-router'
import { ApiError, errorMessage } from '../../api/problem'
import { useHelpTopic } from '../../app/help'
import { SAFE_MARKDOWN } from '../../app/markdown'
import { PageHead } from '../../app/PageHead'
import {
  ACCEPTED_FILES,
  fileUrl,
  isActive,
  MAX_ATTACHMENTS,
  MAX_FILE_BYTES,
  MAX_QUESTION,
  sizeLabel,
  UNTITLED,
  useAgentMessage,
  useAgentSession,
  useAskAgent,
  useAttachFile,
  useCreateSession,
  useRecentSessions,
  useRemoveFile,
  type AgentFile,
  type AgentMessage,
} from './agent'
import { ActionCard } from './ActionCard'
import styles from './AgentPage.module.css'
import { useSkills } from './skills'

const EXAMPLES = [
  'Quais decisões foram tomadas esta semana?',
  'Monte uma tabela com quem ficou de enviar algo e até quando',
  'Compare o documento anexado com o que foi combinado na última reunião',
]

function queriesNote(message: AgentMessage): string {
  if (message.queries === 0) return 'Respondeu sem consultar nada'
  return message.queries === 1 ? 'Fez 1 consulta' : `Fez ${message.queries} consultas`
}

function failure(message: AgentMessage): string {
  if (message.error?.code === 'no_provider') {
    return 'O Agente ainda não tem um modelo configurado. Peça a quem administra o servidor para habilitar um agente para o chat.'
  }
  if (message.error?.code === 'agent_expired') return 'A resposta demorou demais e foi interrompida.'
  return message.error?.message ?? 'A resposta falhou.'
}

/** Um arquivo da conversa: o nome com link para baixar e o tamanho. */
function FileChip({ file, onRemove, busy }: { file: AgentFile; onRemove?: () => void; busy?: boolean }) {
  const unreadable = file.direction === 'input' && file.text_chars === 0
  return (
    <li className={styles.file}>
      <FileText aria-hidden="true" size={14} />
      <a href={fileUrl(file)} download={file.name}>
        {file.name}
      </a>
      <span className="text-muted">{sizeLabel(file.size_bytes)}</span>
      {unreadable && <span className={styles.warn}>sem texto legível</span>}
      {onRemove && (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          aria-label={`Tirar ${file.name}`}
          disabled={busy}
          onClick={onRemove}
        >
          <X aria-hidden="true" size={14} />
        </button>
      )}
    </li>
  )
}

function Files({ files, label }: { files: AgentFile[]; label: string }) {
  if (files.length === 0) return null
  return (
    <ul className={styles.files} aria-label={label}>
      {files.map((file) => (
        <FileChip key={file.id} file={file} />
      ))}
    </ul>
  )
}

function Answer({ message, onRetry }: { message: AgentMessage; onRetry: () => void }) {
  const query = useAgentMessage(message)
  const current = query.data ?? message
  const gone = query.error instanceof ApiError && query.error.status === 404
  return (
    <div className="msg msg-agent">
      <span className="msg-who">Agente</span>
      {gone ? (
        <span className={styles.error}>Esta resposta não existe mais.</span>
      ) : query.isError ? (
        <span className={styles.error}>{errorMessage(query.error)}</span>
      ) : isActive(current) ? (
        <span className={styles.working} aria-label="Trabalhando na resposta">
          Trabalhando na resposta
        </span>
      ) : current.status === 'failed' ? (
        <span className={styles.error}>
          {failure(current)}{' '}
          <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>
            Tentar de novo
          </button>
        </span>
      ) : (
        <>
          <div className={styles.answer}>
            <ReactMarkdown components={SAFE_MARKDOWN}>{current.content}</ReactMarkdown>
          </div>
          <Files files={current.files} label="Arquivos gerados" />
          {current.actions.map((action) => (
            <ActionCard key={action.id} action={action} />
          ))}
          {current.sources.length > 0 && (
            <ul className={styles.sources} aria-label="Fontes">
              {current.sources.map((source) => (
                <li key={source.recording_id}>
                  <Link to={`/gravacoes/${source.recording_id}`}>{source.title}</Link>
                </li>
              ))}
            </ul>
          )}
          <span className="msg-note">{queriesNote(current)}</span>
        </>
      )}
    </div>
  )
}

/** As conversas recentes, ao lado: a atual acesa, a nova e o atalho para todas. */
function RecentSessions({ current }: { current?: string }) {
  const recent = useRecentSessions()
  const items = recent.data?.items ?? []
  return (
    <nav className={styles.aside} aria-label="Conversas recentes">
      <Link to="/agente" className="btn btn-secondary btn-sm">
        Nova conversa
      </Link>
      {items.length > 0 ? (
        <ul className={styles.recent}>
          {items.map((session) => (
            <li key={session.id}>
              <Link to={`/agente/${session.id}`} aria-current={session.id === current ? 'page' : undefined}>
                {session.title || UNTITLED}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        !recent.isPending && <p className="text-muted">Nenhuma conversa ainda.</p>
      )}
      <Link to="/agente/conversas" className={styles.all}>
        Todas as conversas
      </Link>
    </nav>
  )
}

/**
 * A tela Agente: uma conversa guardada sobre as gravações e os arquivos anexados, com as conversas
 * recentes ao lado. Sem conversa na rota, a primeira pergunta (ou o primeiro anexo) abre uma.
 */
export function AgentPage() {
  useHelpTopic('agente')
  const { sessionId } = useParams()
  const navigate = useNavigate()
  const session = useAgentSession(sessionId)
  const create = useCreateSession()
  const ask = useAskAgent()
  const attach = useAttachFile()
  const remove = useRemoveFile()
  const skills = useSkills()
  const enabledSkills = (skills.data?.items ?? []).filter((skill) => skill.enabled)
  const [skill, setSkill] = useState('')
  const [text, setText] = useState('')
  const [uploadError, setUploadError] = useState<string | null>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const fieldId = useId()

  const detail = session.data
  const messages = detail?.messages ?? []
  const pending = detail?.pending_files ?? []
  const busy = ask.isPending || create.isPending
  const missing = session.error instanceof ApiError && session.error.status === 404

  useEffect(() => {
    const log = logRef.current
    if (log) log.scrollTop = log.scrollHeight
  }, [messages.length])

  async function ensureSession(): Promise<string> {
    if (sessionId) return sessionId
    const created = await create.mutateAsync('')
    navigate(`/agente/${created.id}`, { replace: true })
    return created.id
  }

  async function submit(message: string, attachments: string[] = pending.map((file) => file.id)) {
    const question = message.trim()
    if (!question || busy) return
    try {
      const id = await ensureSession()
      // `/nome` digitado vale mais que o seletor: o servidor lê o prefixo.
      const chosen = question.startsWith('/') ? undefined : skill || undefined
      await ask.mutateAsync({ sessionId: id, message: question, attachments, skill: chosen })
      setText('')
    } catch {
      // O erro aparece no alerta do compositor.
    }
  }

  async function onFiles(event: ChangeEvent<HTMLInputElement>) {
    const chosen = Array.from(event.target.files ?? [])
    event.target.value = ''
    setUploadError(null)
    if (pending.length + chosen.length > MAX_ATTACHMENTS) {
      setUploadError(`Anexe até ${MAX_ATTACHMENTS} arquivos por pergunta.`)
      return
    }
    const tooBig = chosen.find((file) => file.size > MAX_FILE_BYTES)
    if (tooBig) {
      setUploadError(`${tooBig.name} passa de 10 MB.`)
      return
    }
    try {
      const id = await ensureSession()
      for (const file of chosen) await attach.mutateAsync({ sessionId: id, file })
    } catch (error) {
      setUploadError(errorMessage(error))
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    void submit(text)
  }

  // "Tentar de novo" repete a pergunta que veio antes da resposta, sem reenviar anexos.
  const questionBefore = (index: number) => {
    const previous = messages[index - 1]
    return previous?.role === 'user' ? previous.content : ''
  }

  const title = sessionId ? detail?.title || UNTITLED : 'Nova conversa'
  const askError = ask.error ?? create.error

  return (
    <div className={styles.layout}>
      <RecentSessions current={sessionId} />
      <div className={styles.page}>
        <PageHead kicker="Agente" title={title} />
        <p className={`text-muted ${styles.lead}`}>
          Pergunte sobre as suas gravações ou sobre um arquivo anexado. O Agente começa pelos resumos, lê as
          transcrições quando o resumo não basta e pode devolver um arquivo para baixar.
        </p>
        {missing ? (
          <p className="alert alert-error" role="alert">
            Esta conversa não existe mais. <Link to="/agente">Começar uma nova</Link>
          </p>
        ) : (
          <>
            <div ref={logRef} className={`chat-log ${styles.log}`} role="log" aria-live="polite" aria-label="Conversa">
              {messages.length === 0 && !session.isFetching && (
                <div className={styles.examples}>
                  <span className="text-muted">Por exemplo:</span>
                  {EXAMPLES.map((example) => (
                    <button
                      key={example}
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => void submit(example)}
                    >
                      {example}
                    </button>
                  ))}
                </div>
              )}
              {messages.map((message, index) =>
                message.role === 'user' ? (
                  <div key={message.id} className="msg msg-user">
                    <span className="msg-who">Você</span>
                    {message.skill && <span className="chip">/{message.skill}</span>} {message.content}
                    <Files files={message.files} label="Anexos" />
                  </div>
                ) : (
                  <Answer key={message.id} message={message} onRetry={() => void submit(questionBefore(index), [])} />
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
                placeholder="Pergunte ou peça um arquivo ao Agente"
                maxLength={MAX_QUESTION}
                value={text}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                    event.preventDefault()
                    void submit(text)
                  }
                }}
              />
              {pending.length > 0 && (
                <ul className={styles.files} aria-label="Anexos da próxima pergunta">
                  {pending.map((file) => (
                    <FileChip key={file.id} file={file} busy={remove.isPending} onRemove={() => remove.mutate(file)} />
                  ))}
                </ul>
              )}
              {(askError || uploadError) && (
                <p className="alert alert-error" role="alert">
                  {uploadError ?? errorMessage(askError)}
                </p>
              )}
              <div className="composer-row">
                <span>Ctrl+Enter envia</span>
                {enabledSkills.length > 0 && (
                  <select
                    className={`input ${styles.skillPicker}`}
                    aria-label="Habilidade"
                    value={skill}
                    onChange={(event) => setSkill(event.target.value)}
                  >
                    <option value="">Sem habilidade</option>
                    {enabledSkills.map((item) => (
                      <option key={item.id} value={item.name}>
                        /{item.name}
                      </option>
                    ))}
                  </select>
                )}
                <input
                  ref={fileRef}
                  type="file"
                  accept={ACCEPTED_FILES}
                  multiple
                  hidden
                  aria-label="Arquivos para anexar"
                  onChange={(event) => void onFiles(event)}
                />
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={attach.isPending || pending.length >= MAX_ATTACHMENTS}
                  onClick={() => fileRef.current?.click()}
                >
                  <Paperclip aria-hidden="true" size={14} /> {attach.isPending ? 'Anexando…' : 'Anexar'}
                </button>
                <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !text.trim()}>
                  Enviar
                </button>
              </div>
              <p className={`text-muted ${styles.hint}`}>
                Anexos: .txt, .md, .csv, .pdf ou .docx, até 10 MB cada. Comece com /nome para usar uma{' '}
                <Link to="/agente/habilidades">habilidade</Link>.
              </p>
            </form>
          </>
        )}
      </div>
    </div>
  )
}
