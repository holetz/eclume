import { useId, useState } from 'react'
import type { Schemas } from '../../api/client'
import { errorMessage } from '../../api/problem'
import { ConfirmDialog } from '../../app/ConfirmDialog'
import { AdminPageHead } from './AdminPageHead'
import styles from './Admin.module.css'
import { foldText, formatShortDate } from './labels'
import { useAllUsers, useSetUserActive } from './queries'

type User = Schemas['AdminUser']

/** Contas de usuário da plataforma: quantas gravações cada uma tem, e desativar ou reativar. */
export function UsersPage() {
  const users = useAllUsers()
  const setActive = useSetUserActive()
  const [query, setQuery] = useState('')
  const [confirming, setConfirming] = useState<User | null>(null)
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
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            aria-label={`Desativar ${user.name}`}
                            onClick={() => setConfirming(user)}
                          >
                            Desativar
                          </button>
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
    </>
  )
}
