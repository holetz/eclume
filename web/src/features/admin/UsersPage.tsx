import { useId, useState } from 'react'
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
      <AdminPageHead title="Usuários" />
      {users.isPending && <p role="status">Carregando usuários…</p>}
      {users.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(users.error)}
        </p>
      )}
      {users.data && (
        <div className={styles.page}>
          <div className="toolbar">
            <label htmlFor={searchId} className="visually-hidden">
              Buscar por nome ou e-mail
            </label>
            <input
              id={searchId}
              className={`input ${styles.search}`}
              type="search"
              placeholder="Buscar por nome ou e-mail"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <span className={`text-muted ${styles.count}`}>
              {all.length === 1 ? '1 conta' : `${all.length} contas`} · {active === 1 ? '1 ativa' : `${active} ativas`}
            </span>
          </div>
          {setActive.isError && (
            <p className="alert alert-error" role="alert">
              {errorMessage(setActive.error)}
            </p>
          )}
          {all.length === 0 ? (
            <p className="text-muted">Nenhuma conta ainda. O cadastro fica em /cadastro.</p>
          ) : shown.length === 0 ? (
            <p className="text-muted">Nenhuma conta com “{query.trim()}”.</p>
          ) : (
            <div className={styles.scroll}>
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Nome</th>
                    <th scope="col">E-mail</th>
                    <th scope="col">Cadastro</th>
                    <th scope="col">Gravações</th>
                    <th scope="col">Estado</th>
                    <th scope="col">
                      <span className="visually-hidden">Ações</span>
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
                          <span className="badge badge-success">Ativa</span>
                        ) : (
                          <span className="badge">Desativada</span>
                        )}
                      </td>
                      <td className={styles.actionsCell}>
                        {user.active ? (
                          <>
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              aria-label={`Gerar link de senha para ${user.name}`}
                              onClick={() => setResetting(user)}
                            >
                              Gerar link de senha
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              aria-label={`Desativar ${user.name}`}
                              onClick={() => setConfirming(user)}
                            >
                              Desativar
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            aria-label={`Reativar ${user.name}`}
                            disabled={setActive.isPending}
                            onClick={() => setActive.mutate({ id: user.id, active: true })}
                          >
                            Reativar
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
          title={`Desativar ${confirming.name}?`}
          confirmLabel="Desativar"
          busy={setActive.isPending}
          onConfirm={() => deactivate(confirming)}
          onCancel={() => setConfirming(null)}
        >
          As sessões são encerradas e os tokens de acesso, revogados. As gravações ficam guardadas.
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
  const create = useCreatePasswordReset()
  const link = create.data

  if (link) {
    return (
      <Dialog
        plain
        title={`Link de senha de ${user.name}`}
        message={`Copie e entregue por fora, pessoalmente, por telefone ou por mensagem, a ${user.name}. Vale por 24 horas e uma só vez; este link não aparece de novo.`}
        onClose={onClose}
        actions={
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Fechar
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
      title={`Gerar link de senha para ${user.name}?`}
      message={`Confirme antes que é ${user.name} quem pede. Quem abrir o link define uma senha nova, e as sessões abertas da conta são encerradas. Um link anterior ainda não usado deixa de valer.`}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancelar
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => create.mutate(user.id)}
            disabled={create.isPending}
            aria-busy={create.isPending}
          >
            Gerar link
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
