import { useId, useState, type FormEvent } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { errorMessage } from '../../api/problem'
import { ConfirmDialog } from '../../app/ConfirmDialog'
import { Dialog } from '../../app/Dialog'
import { useHelpTopic } from '../../app/help'
import { PageHead } from '../../app/PageHead'
import { activeLocale } from '../../i18n'
import { useAllSessions, useDeleteSession, useRenameSession, type AgentSession } from './agent'
import styles from './AgentPage.module.css'

const formats = new Map<string, Intl.DateTimeFormat>()

/** The date and time of the last activity, in the active locale (one formatter per locale). */
function formatWhen(iso: string): string {
  const locale = activeLocale()
  let format = formats.get(locale)
  if (!format) {
    format = new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' })
    formats.set(locale, format)
  }
  return format.format(new Date(iso))
}

function RenameDialog({ session, onClose }: { session: AgentSession; onClose: () => void }) {
  const { t } = useTranslation('agent')
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
      title={t('conversations.renameTitle')}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t('cancel')}
          </button>
          <button type="submit" form={`${fieldId}-form`} className="btn btn-primary" disabled={rename.isPending || !title.trim()}>
            {t('save')}
          </button>
        </>
      }
    >
      <form id={`${fieldId}-form`} className="field" onSubmit={onSubmit}>
        <label htmlFor={fieldId} className="field-label">
          {t('conversations.titleField')}
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

/** The Conversas page: all of the Agent's conversations, newest first, with rename and delete. */
export function ConversationsPage() {
  useHelpTopic('agente')
  const { t } = useTranslation('agent')
  const sessions = useAllSessions()
  const remove = useDeleteSession()
  const [renaming, setRenaming] = useState<AgentSession | null>(null)
  const [deleting, setDeleting] = useState<AgentSession | null>(null)
  const items = sessions.data?.pages.flatMap((page) => page.items) ?? []

  return (
    <div className={styles.page}>
      <PageHead
        kicker={t('kicker')}
        title={t('conversations.title')}
        actions={
          <Link to="/agente" className="btn btn-primary btn-sm">
            {t('newConversation')}
          </Link>
        }
      />
      {sessions.isError ? (
        <p className="alert alert-error" role="alert">
          {errorMessage(sessions.error)}
        </p>
      ) : sessions.isPending ? (
        <p className="text-muted">{t('conversations.loading')}</p>
      ) : items.length === 0 ? (
        <p className="text-muted">
          <Trans t={t} i18nKey="conversations.none" components={{ ask: <Link to="/agente" /> }} />
        </p>
      ) : (
        <ul className={`list ${styles.sessions}`} aria-label={t('conversations.title')}>
          {items.map((session) => (
            <li key={session.id} className="list-row">
              <Link to={`/agente/${session.id}`} className="list-row-title">
                {session.title || t('untitled')}
              </Link>
              <span className="list-row-sub">{t('conversations.lastActivity', { date: formatWhen(session.updated_at) })}</span>
              <span className="list-row-actions">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  aria-label={t('conversations.renameName', { title: session.title || t('untitled') })}
                  onClick={() => setRenaming(session)}
                >
                  {t('conversations.rename')}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  aria-label={t('conversations.deleteName', { title: session.title || t('untitled') })}
                  onClick={() => setDeleting(session)}
                >
                  {t('conversations.delete')}
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
          {t('conversations.loadMore')}
        </button>
      )}
      {renaming && <RenameDialog session={renaming} onClose={() => setRenaming(null)} />}
      {deleting && (
        <ConfirmDialog
          title={t('conversations.deleteTitle')}
          confirmLabel={t('conversations.delete')}
          busy={remove.isPending}
          onCancel={() => setDeleting(null)}
          onConfirm={() => remove.mutate(deleting.id, { onSuccess: () => setDeleting(null) })}
        >
          <p>
            {t('conversations.deleteBody', { title: deleting.title || t('untitled') })}
          </p>
        </ConfirmDialog>
      )}
    </div>
  )
}
