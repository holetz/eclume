import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { api, type Schemas } from '../../api/client'
import { errorMessage, unwrap } from '../../api/problem'
import { useMe } from '../../app/session'
import { usePageTitle } from '../../app/usePageTitle'
import { formatDate, formatDateTime } from '../library/format'
import styles from './Admin.module.css'
import { INVITATION_DAYS, invitationStatus, labelOf, ROLES } from './labels'
import { INVITATIONS_KEY, USERS_KEY, useGroups, useInvitations, useUsers } from './queries'
import { sectionTitle } from './sections'

type User = Schemas['User']
type Role = User['role']
type Invitation = Schemas['Invitation']

/** Contas da organização (papel, desativação) e convites por link. */
export function UsersPage() {
  usePageTitle(sectionTitle('usuarios'))
  const users = useUsers()
  const me = useMe()
  const [created, setCreated] = useState<Invitation | null>(null)

  return (
    <section className={styles.page} aria-labelledby="usuarios-titulo">
      <div className={styles.intro}>
        <h2 id="usuarios-titulo">Usuários e convites</h2>
        <p className="text-muted">
          Desativar encerra as sessões e revoga os tokens da pessoa; as gravações dela continuam. A organização mantém ao
          menos um administrador ativo.
        </p>
      </div>

      <section className={styles.section} aria-labelledby="usuarios-lista">
        <h3 id="usuarios-lista">Usuários</h3>
        {users.isPending && <p role="status">Carregando usuários…</p>}
        {users.isError && (
          <p className="alert alert-error" role="alert">
            {errorMessage(users.error)}
          </p>
        )}
        {users.data && (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Pessoa</th>
                  <th scope="col">Papel</th>
                  <th scope="col">Estado</th>
                  <th scope="col">Último acesso</th>
                  <th scope="col">
                    <span className="visually-hidden">Ações</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {users.data.items.map((user) => (
                  <UserRow key={user.id} user={user} self={user.id === me.data?.user.id} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className={styles.section} aria-labelledby="convites-titulo">
        <h3 id="convites-titulo">Convites</h3>
        {created ? (
          <InvitationLink invitation={created} onDone={() => setCreated(null)} />
        ) : (
          <InviteForm onCreated={setCreated} />
        )}
        <InvitationList />
      </section>
    </section>
  )
}

function useSetUser() {
  const queryClient = useQueryClient()
  return (updated: User) =>
    queryClient.setQueryData<Schemas['UserPage']>(USERS_KEY, (data) =>
      data ? { ...data, items: data.items.map((u) => (u.id === updated.id ? updated : u)) } : data,
    )
}

function UserRow({ user, self }: { user: User; self: boolean }) {
  const setUser = useSetUser()
  const [confirming, setConfirming] = useState(false)
  const roleId = useId()
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
        <span className={styles.strong}>
          {user.name}
          {self && ' (você)'}
        </span>
        <span className={styles.mono}>{user.email}</span>
      </th>
      <td>
        <label htmlFor={roleId} className="visually-hidden">
          Papel de {user.name}
        </label>
        <select
          id={roleId}
          className="input"
          value={user.role}
          disabled={patch.isPending || !user.active}
          onChange={(e) => patch.mutate({ role: e.target.value as Role })}
        >
          {!ROLES.some((option) => option.value === user.role) && <option value={user.role}>{user.role}</option>}
          {ROLES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </td>
      <td>
        {user.active ? <span className="badge badge-success">Ativo</span> : <span className="badge">Desativado</span>}
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
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setConfirming(false)}>
                Manter
              </button>
            </div>
          ) : (
            !self && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setConfirming(true)}
                aria-label={`Desativar ${user.name}`}
              >
                Desativar
              </button>
            )
          )
        ) : (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
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

function InviteForm({ onCreated }: { onCreated: (invitation: Invitation) => void }) {
  const queryClient = useQueryClient()
  const groups = useGroups()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Role>('member')
  const [groupIds, setGroupIds] = useState<string[]>([])
  const [days, setDays] = useState(7)
  const ids = { email: useId(), role: useId(), days: useId() }
  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/api/v1/admin/invitations', {
          body: { email: email.trim(), role, group_ids: groupIds, expires_in_days: days },
        }),
      ),
    onSuccess: (invitation) => {
      void queryClient.invalidateQueries({ queryKey: INVITATIONS_KEY })
      setEmail('')
      setRole('member')
      setGroupIds([])
      onCreated(invitation)
    },
  })

  function submit(event: FormEvent) {
    event.preventDefault()
    if (email.trim()) create.mutate()
  }

  return (
    <form className={`card ${styles.form}`} onSubmit={submit} aria-label="Novo convite">
      <div className={styles.row}>
        <div className="field">
          <label htmlFor={ids.email}>E-mail</label>
          <input id={ids.email} className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={ids.role}>Papel</label>
          <select id={ids.role} className="input" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {ROLES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={ids.days}>Validade do link</label>
          <select id={ids.days} className="input" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {INVITATION_DAYS.map((value) => (
              <option key={value} value={value}>
                {value === 1 ? '1 dia' : `${value} dias`}
              </option>
            ))}
          </select>
        </div>
      </div>
      {(groups.data?.items.length ?? 0) > 0 && (
        <fieldset className={styles.fieldset}>
          <legend>Grupos</legend>
          <div className={styles.row}>
            {groups.data?.items.map((group) => (
              <label key={group.id} className={styles.check}>
                <input
                  type="checkbox"
                  checked={groupIds.includes(group.id)}
                  onChange={(e) =>
                    setGroupIds((current) =>
                      e.target.checked ? [...current, group.id] : current.filter((id) => id !== group.id),
                    )
                  }
                />
                <span>{group.name}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {create.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(create.error)}
        </p>
      )}
      <div>
        <button type="submit" className="btn btn-primary" disabled={create.isPending || !email.trim()}>
          {create.isPending ? 'Criando…' : 'Criar convite'}
        </button>
      </div>
    </form>
  )
}

function InvitationLink({ invitation, onDone }: { invitation: Invitation; onDone: () => void }) {
  const [copied, setCopied] = useState(false)
  const panel = useRef<HTMLDivElement>(null)
  const linkId = useId()
  const link = invitation.accept_url ?? ''

  useEffect(() => panel.current?.focus(), [])

  async function copy() {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div ref={panel} tabIndex={-1} role="region" className={`card ${styles.form}`} aria-labelledby="convite-criado">
      <h4 id="convite-criado">Convite para {invitation.email} criado</h4>
      <p className="alert alert-warning">
        Envie este link à pessoa agora: ele não será mostrado de novo. Vale até {formatDateTime(invitation.expires_at)}.
      </p>
      <div className={styles.secretRow}>
        <label htmlFor={linkId} className="visually-hidden">
          Link do convite
        </label>
        <input id={linkId} className={`input ${styles.secretValue}`} readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
        <button type="button" className="btn btn-primary" onClick={copy}>
          {copied ? 'Copiado' : 'Copiar'}
        </button>
      </div>
      <p className="visually-hidden" role="status">
        {copied ? 'Link copiado para a área de transferência.' : ''}
      </p>
      <div>
        <button type="button" className="btn btn-secondary" onClick={onDone}>
          Pronto, já enviei
        </button>
      </div>
    </div>
  )
}

function InvitationList() {
  const invitations = useInvitations()
  if (invitations.isPending) return <p role="status">Carregando convites…</p>
  if (invitations.isError) {
    return (
      <p className="alert alert-error" role="alert">
        {errorMessage(invitations.error)}
      </p>
    )
  }
  if (invitations.data.items.length === 0) return <p className="text-muted">Nenhum convite criado.</p>
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">E-mail</th>
            <th scope="col">Papel</th>
            <th scope="col">Estado</th>
            <th scope="col">Convidado por</th>
            <th scope="col">
              <span className="visually-hidden">Ações</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {invitations.data.items.map((invitation) => (
            <InvitationRow key={invitation.id} invitation={invitation} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function InvitationRow({ invitation }: { invitation: Invitation }) {
  const queryClient = useQueryClient()
  const status = invitationStatus(invitation)
  const revoke = useMutation({
    mutationFn: () =>
      unwrap(
        api.DELETE('/api/v1/admin/invitations/{invitation_id}', { params: { path: { invitation_id: invitation.id } } }),
      ),
    onSuccess: () =>
      queryClient.setQueryData<Schemas['InvitationPage']>(INVITATIONS_KEY, (data) =>
        data ? { ...data, items: data.items.filter((i) => i.id !== invitation.id) } : data,
      ),
  })
  const detail = invitation.accepted_at
    ? `em ${formatDate(invitation.accepted_at)}`
    : `até ${formatDate(invitation.expires_at)}`

  return (
    <tr data-muted={status.label !== 'Pendente'}>
      <th scope="row" className={styles.mono}>
        {invitation.email}
      </th>
      <td>{labelOf(ROLES, invitation.role)}</td>
      <td>
        <span className={`badge badge-${status.tone}`}>{status.label}</span> <span className={styles.meta}>{detail}</span>
      </td>
      <td>{invitation.created_by.name}</td>
      <td className={styles.actionsCell}>
        {!invitation.accepted_at && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => revoke.mutate()}
            disabled={revoke.isPending}
            aria-label={`Revogar convite de ${invitation.email}`}
          >
            Revogar
          </button>
        )}
        {revoke.isError && (
          <span className={styles.error} role="alert">
            {errorMessage(revoke.error)}
          </span>
        )}
      </td>
    </tr>
  )
}
