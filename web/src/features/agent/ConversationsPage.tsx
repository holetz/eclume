import { useId, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { errorMessage } from '../../api/problem'
import { ConfirmDialog } from '../../app/ConfirmDialog'
import { Dialog } from '../../app/Dialog'
import { useHelpTopic } from '../../app/help'
import { PageHead } from '../../app/PageHead'
import { UNTITLED, useAllSessions, useDeleteSession, useRenameSession, type AgentSession } from './agent'
import styles from './AgentPage.module.css'

const WHEN = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' })

function RenameDialog({ session, onClose }: { session: AgentSession; onClose: () => void }) {
  const rename = useRenameSession()
  const [title, setTitle] = useState(session.title)
  const fieldId = useId()

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (!title.trim()) return
    rename.mutate({ id: session.id, title: title.trim() }, { onSuccess: onClose })
  }

  return (
    <Dialog
      title="Renomear conversa"
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" form={`${fieldId}-form`} className="btn btn-primary" disabled={rename.isPending || !title.trim()}>
            Salvar
          </button>
        </>
      }
    >
      <form id={`${fieldId}-form`} className="field" onSubmit={onSubmit}>
        <label htmlFor={fieldId} className="field-label">
          Título
        </label>
        <input
          id={fieldId}
          className="input"
          maxLength={120}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        {rename.isError && (
          <p className="alert alert-error" role="alert">
            {errorMessage(rename.error)}
          </p>
        )}
      </form>
    </Dialog>
  )
}

/** A página Conversas: todas as conversas do Agente, da mais recente, com renomear e excluir. */
export function ConversationsPage() {
  useHelpTopic('agente')
  const sessions = useAllSessions()
  const remove = useDeleteSession()
  const [renaming, setRenaming] = useState<AgentSession | null>(null)
  const [deleting, setDeleting] = useState<AgentSession | null>(null)
  const items = sessions.data?.pages.flatMap((page) => page.items) ?? []

  return (
    <div className={styles.page}>
      <PageHead
        kicker="Agente"
        title="Conversas"
        actions={
          <Link to="/agente" className="btn btn-primary btn-sm">
            Nova conversa
          </Link>
        }
      />
      {sessions.isError ? (
        <p className="alert alert-error" role="alert">
          {errorMessage(sessions.error)}
        </p>
      ) : sessions.isPending ? (
        <p className="text-muted">Carregando as conversas…</p>
      ) : items.length === 0 ? (
        <p className="text-muted">
          Nenhuma conversa ainda. <Link to="/agente">Pergunte ao Agente</Link> e a conversa fica guardada aqui.
        </p>
      ) : (
        <ul className={`list ${styles.sessions}`} aria-label="Conversas">
          {items.map((session) => (
            <li key={session.id} className="list-row">
              <Link to={`/agente/${session.id}`} className="list-row-title">
                {session.title || UNTITLED}
              </Link>
              <span className="list-row-sub">Última atividade em {WHEN.format(new Date(session.updated_at))}</span>
              <span className="list-row-actions">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  aria-label={`Renomear ${session.title || UNTITLED}`}
                  onClick={() => setRenaming(session)}
                >
                  Renomear
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  aria-label={`Excluir ${session.title || UNTITLED}`}
                  onClick={() => setDeleting(session)}
                >
                  Excluir
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {sessions.hasNextPage && (
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={sessions.isFetchingNextPage}
          onClick={() => void sessions.fetchNextPage()}
        >
          Carregar mais
        </button>
      )}
      {renaming && <RenameDialog session={renaming} onClose={() => setRenaming(null)} />}
      {deleting && (
        <ConfirmDialog
          title="Excluir conversa"
          confirmLabel="Excluir"
          busy={remove.isPending}
          onCancel={() => setDeleting(null)}
          onConfirm={() => remove.mutate(deleting.id, { onSuccess: () => setDeleting(null) })}
        >
          <p>
            “{deleting.title || UNTITLED}” sai com as mensagens, os anexos e os arquivos gerados. Não dá para
            desfazer.
          </p>
        </ConfirmDialog>
      )}
    </div>
  )
}
