import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { FileText, Paperclip, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import { Link, useNavigate, useParams } from 'react-router'
import { ApiError, errorMessage } from '../../api/problem'
import { useHelpTopic } from '../../app/help'
import { SAFE_MARKDOWN } from '../../app/markdown'
import { i18n } from '../../i18n'
import { PageHead } from '../../app/PageHead'
import {
  ACCEPTED_FILES,
  fileUrl,
  isActive,
  MAX_ATTACHMENTS,
  MAX_FILE_BYTES,
  MAX_QUESTION,
  sizeLabel,
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

const EXAMPLES = ['page.example1', 'page.example2', 'page.example3'] as const

function queriesNote(message: AgentMessage): string {
  return i18n.t('agent:answer.queries', { count: message.queries })
}

function failure(message: AgentMessage): string {
  if (message.error?.code === 'no_provider') {
    return i18n.t('agent:answer.noProvider')
  }
  if (message.error?.code === 'agent_expired') return i18n.t('agent:answer.expired')
  return message.error?.message ?? i18n.t('agent:answer.failed')
}

/** One conversation file: the name with a download link, and the size. */
function FileChip({ file, onRemove, busy }: { file: AgentFile; onRemove?: () => void; busy?: boolean }) {
  const { t } = useTranslation('agent')
  const unreadable = file.direction === 'input' && file.text_chars === 0
  return (
    <li className={styles.file}>
      <FileText aria-hidden="true" size={14} />
      <a href={fileUrl(file)} download={file.name}>
        {file.name}
      </a>
      <span className="text-muted">{sizeLabel(file.size_bytes)}</span>
      {unreadable && <span className={styles.warn}>{t('file.unreadable')}</span>}
      {onRemove && (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          aria-label={t('file.remove', { name: file.name })}
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
  const { t } = useTranslation('agent')
  const query = useAgentMessage(message)
  const current = query.data ?? message
  const gone = query.error instanceof ApiError && query.error.status === 404
  return (
    <div className="msg msg-agent">
      <span className="msg-who">{t('answer.who')}</span>
      {gone ? (
        <span className={styles.error}>{t('answer.gone')}</span>
      ) : query.isError ? (
        <span className={styles.error}>{errorMessage(query.error)}</span>
      ) : isActive(current) ? (
        <span className={styles.working} aria-label={t('answer.working')}>
          {t('answer.working')}
        </span>
      ) : current.status === 'failed' ? (
        <span className={styles.error}>
          {failure(current)}{' '}
          <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>
            {t('answer.retry')}
          </button>
        </span>
      ) : (
        <>
          <div className={styles.answer}>
            <ReactMarkdown components={SAFE_MARKDOWN}>{current.content}</ReactMarkdown>
          </div>
          <Files files={current.files} label={t('answer.generated')} />
          {current.actions.map((action) => (
            <ActionCard key={action.id} action={action} />
          ))}
          {current.sources.length > 0 && (
            <ul className={styles.sources} aria-label={t('answer.sources')}>
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

/** The recent conversations, alongside: the current one lit, the new one and the shortcut to all. */
function RecentSessions({ current }: { current?: string }) {
  const { t } = useTranslation('agent')
  const recent = useRecentSessions()
  const items = recent.data?.items ?? []
  return (
    <nav className={styles.aside} aria-label={t('recent.label')}>
      <Link to="/agente" className="btn btn-secondary btn-sm">
        {t('newConversation')}
      </Link>
      {items.length > 0 ? (
        <ul className={styles.recent}>
          {items.map((session) => (
            <li key={session.id}>
              <Link to={`/agente/${session.id}`} aria-current={session.id === current ? 'page' : undefined}>
                {session.title || t('untitled')}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        !recent.isPending && <p className="text-muted">{t('recent.none')}</p>
      )}
      <Link to="/agente/conversas" className={styles.all}>
        {t('recent.all')}
      </Link>
    </nav>
  )
}

/**
 * The Agente screen: a stored conversation about the recordings and attached files, with the recent
 * conversations alongside. With no conversation in the route, the first question (or attachment) opens one.
 */
export function AgentPage() {
  useHelpTopic('agente')
  const { t } = useTranslation('agent')
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
      // A typed `/name` wins over the picker: the server reads the prefix.
      const chosen = question.startsWith('/') ? undefined : skill || undefined
      await ask.mutateAsync({ sessionId: id, message: question, attachments, skill: chosen })
      setText('')
    } catch {
      // The error shows in the composer's alert.
    }
  }

  async function onFiles(event: ChangeEvent<HTMLInputElement>) {
    const chosen = Array.from(event.target.files ?? [])
    event.target.value = ''
    setUploadError(null)
    if (pending.length + chosen.length > MAX_ATTACHMENTS) {
      setUploadError(t('page.maxAttachments', { max: MAX_ATTACHMENTS }))
      return
    }
    const tooBig = chosen.find((file) => file.size > MAX_FILE_BYTES)
    if (tooBig) {
      setUploadError(t('page.tooBig', { name: tooBig.name }))
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

  // "Tentar de novo" repeats the question that came before the answer, without resending attachments.
  const questionBefore = (index: number) => {
    const previous = messages[index - 1]
    return previous?.role === 'user' ? previous.content : ''
  }

  const title = sessionId ? detail?.title || t('untitled') : t('newConversation')
  const askError = ask.error ?? create.error

  return (
    <div className={styles.layout}>
      <RecentSessions current={sessionId} />
      <div className={styles.page}>
        <PageHead kicker={t('kicker')} title={title} />
        <p className={`text-muted ${styles.lead}`}>
          {t('page.lead')}
        </p>
        {missing ? (
          <p className="alert alert-error" role="alert">
            <Trans t={t} i18nKey="page.missing" components={{ new: <Link to="/agente" /> }} />
          </p>
        ) : (
          <>
            <div ref={logRef} className={`chat-log ${styles.log}`} role="log" aria-live="polite" aria-label={t('page.log')}>
              {messages.length === 0 && !session.isFetching && (
                <div className={styles.examples}>
                  <span className="text-muted">{t('page.forExample')}</span>
                  {EXAMPLES.map((key) => t(key)).map((example) => (
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
                    <span className="msg-who">{t('page.you')}</span>
                    {message.skill && <span className="chip">/{message.skill}</span>} {message.content}
                    <Files files={message.files} label={t('page.attachments')} />
                  </div>
                ) : (
                  <Answer key={message.id} message={message} onRetry={() => void submit(questionBefore(index), [])} />
                ),
              )}
            </div>
            <form className="composer" onSubmit={onSubmit}>
              <label htmlFor={fieldId} className="visually-hidden">
                {t('page.question')}
              </label>
              <textarea
                id={fieldId}
                className="input"
                placeholder={t('page.placeholder')}
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
                <ul className={styles.files} aria-label={t('page.nextAttachments')}>
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
                <span>{t('page.shortcut')}</span>
                {enabledSkills.length > 0 && (
                  <select
                    className={`input ${styles.skillPicker}`}
                    aria-label={t('page.skill')}
                    value={skill}
                    onChange={(event) => setSkill(event.target.value)}
                  >
                    <option value="">{t('page.noSkill')}</option>
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
                  aria-label={t('page.filesToAttach')}
                  onChange={(event) => void onFiles(event)}
                />
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={attach.isPending || pending.length >= MAX_ATTACHMENTS}
                  onClick={() => fileRef.current?.click()}
                >
                  <Paperclip aria-hidden="true" size={14} /> {attach.isPending ? t('page.attaching') : t('page.attach')}
                </button>
                <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !text.trim()}>
                  {t('page.send')}
                </button>
              </div>
              <p className={`text-muted ${styles.hint}`}>
                <Trans t={t} i18nKey="page.hint" components={{ skill: <Link to="/agente/habilidades" /> }} />
              </p>
            </form>
          </>
        )}
      </div>
    </div>
  )
}
