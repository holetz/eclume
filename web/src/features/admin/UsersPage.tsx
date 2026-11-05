import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Schemas } from '../../api/client'
import { errorMessage } from '../../api/problem'
import { ConfirmDialog } from '../../app/ConfirmDialog'
import { CopyValue } from '../../app/CopyValue'
import { Dialog } from '../../app/Dialog'
import { AdminPageHead } from './AdminPageHead'
import styles from './Admin.module.css'
import { foldText, formatShortDate } from './labels'
import { useAllUsers, useCreatePasswordReset, useSetUserActive } from './queries'

type User = Schemas['AdminUser']

/** Platform user accounts: recordings per account, deactivate or reactivate, password link. */
export function UsersPage() {
  const { t } = useTranslation('admin')
  const users = useAllUsers()
  const setActive = useSetUserActive()
  const [query, setQuery] = useState('')
  const [confirming, setConfirming] = useState<User | null>(null)
  const [resetting, setResetting] = useState<User | null>(null)
  const searchId = useId()

  const all = users.data ?? []
  const term = foldText(query.trim())
  const shown = term ? all.filter((user) => foldText(`${user.name} ${user.email}`).includes(term)) : all
  const active = all.filter((user) => user.active).length

  function deactivate(user: User) {
    setActive.mutate({ id: user.id, active: false }, { onSuccess: () => setConfirming(null) })
  }

  return (
    <>
      <AdminPageHead title={t('users.title')} />
      {users.isPending && <p role="status">{t('users.loading')}</p>}
      {users.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(users.error)}
        </p>
      )}
      {users.data && (
        <div className={styles.page}>
          <div className="toolbar">
            <label htmlFor={searchId} className="visually-hidden">
              {t('users.search')}
            </label>
            <input
              id={searchId}
              className={`input ${styles.search}`}
              type="search"
              placeholder={t('users.search')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <span className={`text-muted ${styles.count}`}>
              {t('users.accounts', { count: all.length })} · {t('users.active', { count: active })}
            </span>
          </div>
          {setActive.isError && (
            <p className="alert alert-error" role="alert">
              {errorMessage(setActive.error)}
            </p>
          )}
          {all.length === 0 ? (
            <p className="text-muted">{t('users.none')}</p>
          ) : shown.length === 0 ? (
            <p className="text-muted">{t('users.noMatch', { query: query.trim() })}</p>
          ) : (
            <div className={styles.scroll}>
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">{t('users.name')}</th>
                    <th scope="col">{t('users.email')}</th>
                    <th scope="col">{t('users.created')}</th>
                    <th scope="col">{t('users.recordings')}</th>
                    <th scope="col">{t('users.state')}</th>
                    <th scope="col">
                      <span className="visually-hidden">{t('users.actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((user) => (
                    <tr key={user.id}>
                      <td>
                        <strong>{user.name}</strong>
                      </td>
                      <td className={`mono ${styles.small}`}>{user.email}</td>
                      <td className="tabular">{formatShortDate(user.created_at)}</td>
                      <td className="tabular">{user.recording_count}</td>
                      <td>
                        {user.active ? (
                          <span className="badge badge-success">{t('users.activeBadge')}</span>
                        ) : (
                          <span className="badge">{t('users.inactiveBadge')}</span>
                        )}
                      </td>
                      <td className={styles.actionsCell}>
                        {user.active ? (
                          <>
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              aria-label={t('users.resetFor', { name: user.name })}
                              onClick={() => setResetting(user)}
                            >
                              {t('users.reset')}
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              aria-label={t('users.deactivateName', { name: user.name })}
                              onClick={() => setConfirming(user)}
                            >
                              {t('users.deactivate')}
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            aria-label={t('users.reactivateName', { name: user.name })}
                            disabled={setActive.isPending}
                            onClick={() => setActive.mutate({ id: user.id, active: true })}
                          >
                            {t('users.reactivate')}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      {confirming && (
        <ConfirmDialog
          title={t('users.deactivateTitle', { name: confirming.name })}
          confirmLabel={t('users.deactivate')}
          busy={setActive.isPending}
          onConfirm={() => deactivate(confirming)}
          onCancel={() => setConfirming(null)}
        >
          {t('users.deactivateBody')}
        </ConfirmDialog>
      )}
      {resetting && <PasswordResetDialog user={resetting} onClose={() => setResetting(null)} />}
    </>
  )
}

/**
 * Generates the password reset link after confirming and shows it once to copy. Generating another
 * expires the previous one; the admin hands the link over out of band, after confirming who asks.
 */
function PasswordResetDialog({ user, onClose }: { user: User; onClose: () => void }) {
  const { t } = useTranslation(['admin', 'common'])
  const create = useCreatePasswordReset()
  const link = create.data

  if (link) {
    return (
      <Dialog
        plain
        title={t('users.linkTitle', { name: user.name })}
        message={t('users.linkMessage', { name: user.name })}
        onClose={onClose}
        actions={
          <button type="button" className="btn btn-primary" onClick={onClose}>
            {t('common:close')}
          </button>
        }
      >
        <CopyValue value={link.url} />
      </Dialog>
    )
  }
  return (
    <Dialog
      plain
      title={t('users.confirmTitle', { name: user.name })}
      message={t('users.confirmMessage', { name: user.name })}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            {t('common:cancel')}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => create.mutate(user.id)}
            disabled={create.isPending}
            aria-busy={create.isPending}
          >
            {t('users.make')}
          </button>
        </>
      }
    >
      {create.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(create.error)}
        </p>
      )}
    </Dialog>
  )
}
