import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api, type Schemas } from '../../api/client'
import { errorMessage, unwrap } from '../../api/problem'
import { usePageTitle } from '../../app/usePageTitle'
import { formatDateTime } from '../library/format'
import styles from './Admin.module.css'
import { USERS_KEY, useUsers } from './queries'
import { sectionTitle } from './sections'

type User = Schemas['AdminUser']

/** Contas de usuário da plataforma: quantas gravações cada uma tem, e desativar ou reativar. */
export function UsersPage() {
  usePageTitle(sectionTitle('usuarios'))
  const users = useUsers()

  return (
    <section className={styles.page} aria-labelledby="usuarios-titulo">
      <div className={styles.intro}>
        <h2 id="usuarios-titulo">Usuários</h2>
        <p className="muted">
          Cada pessoa cria a própria conta pelo cadastro. Desativar encerra as sessões e revoga os tokens da conta; as
          gravações dela continuam. O painel não mostra o conteúdo de ninguém.
        </p>
      </div>

      <section className={styles.section} aria-labelledby="usuarios-lista">
        <h3 id="usuarios-lista">Contas</h3>
        {users.isPending && <p role="status">Carregando usuários…</p>}
        {users.isError && (
          <p className="alert alert-error" role="alert">
            {errorMessage(users.error)}
          </p>
        )}
        {users.data && users.data.items.length === 0 && <p className="muted">Nenhuma conta criada ainda.</p>}
        {users.data && users.data.items.length > 0 && (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Pessoa</th>
                  <th scope="col">Gravações</th>
                  <th scope="col">Estado</th>
                  <th scope="col">Último acesso</th>
                  <th scope="col">
                    <span className="visually-hidden">Ações</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {users.data.items.map((user) => (
                  <UserRow key={user.id} user={user} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </section>
  )
}

function useSetUser() {
  const queryClient = useQueryClient()
  return (updated: User) =>
    queryClient.setQueryData<Schemas['AdminUserPage']>(USERS_KEY, (data) =>
      data ? { ...data, items: data.items.map((u) => (u.id === updated.id ? updated : u)) } : data,
    )
}

function UserRow({ user }: { user: User }) {
  const setUser = useSetUser()
  const [confirming, setConfirming] = useState(false)
  const patch = useMutation({
    mutationFn: (body: Schemas['UserPatch']) =>
      unwrap(api.PATCH('/api/v1/admin/users/{user_id}', { params: { path: { user_id: user.id } }, body })),
    onSuccess: (updated) => {
      setUser(updated)
      setConfirming(false)
    },
  })

  return (
    <tr data-muted={!user.active}>
      <th scope="row">
        <span className={styles.strong}>{user.name}</span>
        <span className={styles.mono}>{user.email}</span>
      </th>
      <td>{user.recording_count}</td>
      <td>
        {user.active ? <span className="badge badge-success">Ativo</span> : <span className="badge badge-neutral">Desativado</span>}
      </td>
      <td>{user.last_login_at ? formatDateTime(user.last_login_at) : 'Nunca entrou'}</td>
      <td className={styles.actionsCell}>
        {user.active ? (
          confirming ? (
            <div className={styles.confirm} role="group" aria-label={`Confirmar desativação de ${user.name}`}>
              <span>Encerra as sessões e revoga os tokens.</span>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={() => patch.mutate({ active: false })}
                disabled={patch.isPending}
              >
                Confirmar desativação
              </button>
              <button type="button" className="btn btn-sm" onClick={() => setConfirming(false)}>
                Manter
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setConfirming(true)}
              aria-label={`Desativar ${user.name}`}
            >
              Desativar
            </button>
          )
        ) : (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => patch.mutate({ active: true })}
            disabled={patch.isPending}
            aria-label={`Reativar ${user.name}`}
          >
            Reativar
          </button>
        )}
        {patch.isError && (
          <span className={styles.error} role="alert">
            {errorMessage(patch.error)}
          </span>
        )}
      </td>
    </tr>
  )
}
