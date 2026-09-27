import { useInfiniteQuery, useMutation, useQueryClient, type InfiniteData } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { api, type Schemas } from '../../api/client'
import { errorMessage, unwrap } from '../../api/problem'
import { useHelpTopic } from '../../app/help'
import { usePageTitle } from '../../app/usePageTitle'
import { formatDate, formatDateTime } from '../library/format'
import { EXPIRATIONS, expiresAt, PRESETS, SCOPES, scopeLabel, type Scope } from './scopes'
import styles from './TokensPage.module.css'

type Token = Schemas['Token']
type TokenPages = InfiniteData<Schemas['TokenPage'], string | null>

const TOKENS_KEY = ['tokens'] as const

export function TokensPage() {
  usePageTitle('Tokens de acesso')
  useHelpTopic('tokens')
  const [created, setCreated] = useState<Schemas['TokenCreated'] | null>(null)
  const tokens = useInfiniteQuery({
    queryKey: TOKENS_KEY,
    queryFn: ({ pageParam }) =>
      unwrap(api.GET('/api/v1/tokens', { params: { query: { limit: 50, ...(pageParam ? { cursor: pageParam } : {}) } } })),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
  })
  const items = tokens.data?.pages.flatMap((page) => page.items) ?? []

  return (
    <section className={styles.page} aria-labelledby="tokens-titulo">
      <header className={styles.header}>
        <h1 id="tokens-titulo">Tokens de acesso</h1>
        <p className="text-muted">
          Um token pessoal (PAT) dá acesso à API em seu nome, limitado aos escopos escolhidos. Use no app desktop e na
          integração com o lumea. Trate-o como uma senha.
        </p>
      </header>

      {created ? (
        <SecretPanel created={created} onDone={() => setCreated(null)} />
      ) : (
        <CreateTokenForm onCreated={setCreated} />
      )}

      <section className={styles.listSection} aria-labelledby="tokens-lista">
        <h2 id="tokens-lista">Seus tokens</h2>
        {tokens.isPending && <p role="status">Carregando tokens…</p>}
        {tokens.isError && (
          <p className="alert alert-error" role="alert">
            {errorMessage(tokens.error)}
          </p>
        )}
        {tokens.isSuccess && items.length === 0 && <p className="text-muted">Você ainda não criou nenhum token.</p>}
        {items.length > 0 && (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Nome</th>
                  <th scope="col">Escopos</th>
                  <th scope="col">Último uso</th>
                  <th scope="col">Validade</th>
                  <th scope="col">
                    <span className="visually-hidden">Ações</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((token) => (
                  <TokenRow key={token.id} token={token} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {tokens.hasNextPage && (
          <button type="button" className="btn btn-secondary" onClick={() => tokens.fetchNextPage()} disabled={tokens.isFetchingNextPage}>
            Carregar mais
          </button>
        )}
      </section>
    </section>
  )
}

function CreateTokenForm({ onCreated }: { onCreated: (created: Schemas['TokenCreated']) => void }) {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<Scope[]>([])
  const [expiration, setExpiration] = useState('never')
  const nameId = useId()
  const expirationId = useId()
  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/api/v1/tokens', {
          body: {
            name: name.trim(),
            scopes,
            expires_at: expiresAt(EXPIRATIONS.find((e) => e.value === expiration)?.days ?? null),
          },
        }),
      ),
    onSuccess: (result) => {
      queryClient.setQueryData<TokenPages>(TOKENS_KEY, (data) =>
        data
          ? {
              ...data,
              pages: data.pages.map((page, i) => (i === 0 ? { ...page, items: [result.token, ...page.items] } : page)),
            }
          : data,
      )
      setName('')
      setScopes([])
      setExpiration('never')
      onCreated(result)
    },
  })

  function submit(event: FormEvent) {
    event.preventDefault()
    if (name.trim() && scopes.length > 0) create.mutate()
  }

  function toggle(scope: Scope, checked: boolean) {
    setScopes((current) => (checked ? [...current, scope] : current.filter((s) => s !== scope)))
  }

  return (
    <form className={`card ${styles.form}`} onSubmit={submit} aria-labelledby="novo-token">
      <h2 id="novo-token">Novo token</h2>
      <div className="field">
        <label htmlFor={nameId}>Nome</label>
        <input
          id={nameId}
          className="input"
          value={name}
          maxLength={100}
          onChange={(event) => setName(event.target.value)}
          placeholder="Ex.: App desktop — notebook"
        />
        <span className="field-hint">Para reconhecer onde o token está em uso.</span>
      </div>
      <fieldset className={styles.scopes}>
        <legend>Escopos</legend>
        <div className={styles.presets}>
          <span className="field-hint">Combinações prontas:</span>
          {PRESETS.map((preset) => (
            <button
              key={preset.name}
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => {
                setScopes(preset.scopes)
                if (!name.trim()) setName(preset.name)
              }}
            >
              {preset.label}
            </button>
          ))}
        </div>
        <div className={styles.scopeGrid}>
          {SCOPES.map(({ scope, label, description }) => (
            <label key={scope} className={styles.scope}>
              <input type="checkbox" checked={scopes.includes(scope)} onChange={(e) => toggle(scope, e.target.checked)} />
              <span>
                <span className={styles.scopeLabel}>{label}</span>
                <span className={styles.scopeCode}>{scope}</span>
                <span className="field-hint">{description}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className={`field ${styles.expiration}`}>
        <label htmlFor={expirationId}>Validade</label>
        <select id={expirationId} className="input" value={expiration} onChange={(e) => setExpiration(e.target.value)}>
          {EXPIRATIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      {create.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(create.error)}
        </p>
      )}
      <div>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={create.isPending || !name.trim() || scopes.length === 0}
        >
          {create.isPending ? 'Criando…' : 'Criar token'}
        </button>
      </div>
    </form>
  )
}

function SecretPanel({ created, onDone }: { created: Schemas['TokenCreated']; onDone: () => void }) {
  const [copied, setCopied] = useState(false)
  const panel = useRef<HTMLDivElement>(null)
  const secretId = useId()

  useEffect(() => panel.current?.focus(), [])

  async function copy() {
    try {
      await navigator.clipboard.writeText(created.secret)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div ref={panel} tabIndex={-1} role="region" className={`card ${styles.secret}`} aria-labelledby="token-criado">
      <h2 id="token-criado">Token “{created.token.name}” criado</h2>
      <p className="alert alert-warning">Copie o token agora: ele não será mostrado de novo.</p>
      <div className={styles.secretRow}>
        <label htmlFor={secretId} className="visually-hidden">
          Token
        </label>
        <input
          id={secretId}
          className={`input ${styles.secretValue}`}
          readOnly
          value={created.secret}
          onFocus={(event) => event.currentTarget.select()}
        />
        <button type="button" className="btn btn-primary" onClick={copy}>
          {copied ? 'Copiado' : 'Copiar'}
        </button>
      </div>
      <p className="visually-hidden" role="status">
        {copied ? 'Token copiado para a área de transferência.' : ''}
      </p>
      <div>
        <button type="button" className="btn btn-secondary" onClick={onDone}>
          Pronto, já guardei
        </button>
      </div>
    </div>
  )
}

function TokenRow({ token }: { token: Token }) {
  const queryClient = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const revoke = useMutation({
    mutationFn: () => unwrap(api.DELETE('/api/v1/tokens/{token_id}', { params: { path: { token_id: token.id } } })),
    onSuccess: () => {
      const revokedAt = new Date().toISOString()
      queryClient.setQueryData<TokenPages>(TOKENS_KEY, (data) =>
        data
          ? {
              ...data,
              pages: data.pages.map((page) => ({
                ...page,
                items: page.items.map((t) => (t.id === token.id ? { ...t, revoked_at: revokedAt } : t)),
              })),
            }
          : data,
      )
      setConfirming(false)
    },
  })
  const expired = token.expires_at !== null && new Date(token.expires_at) < new Date()

  return (
    <tr data-revoked={token.revoked_at !== null}>
      <th scope="row">
        <span className={styles.tokenName}>{token.name}</span>
        <span className={styles.prefix}>{token.prefix}…</span>
      </th>
      <td>
        <ul className={styles.scopeList}>
          {token.scopes.map((scope) => (
            <li key={scope} title={scope}>
              {scopeLabel(scope)}
            </li>
          ))}
        </ul>
      </td>
      <td>{token.last_used_at ? formatDateTime(token.last_used_at) : 'Nunca usado'}</td>
      <td>
        {token.revoked_at ? (
          <span className="badge badge-danger">Revogado em {formatDate(token.revoked_at)}</span>
        ) : expired ? (
          <span className="badge badge-warning">Expirado</span>
        ) : token.expires_at ? (
          `Até ${formatDate(token.expires_at)}`
        ) : (
          'Não expira'
        )}
      </td>
      <td className={styles.actionsCell}>
        {!token.revoked_at &&
          (confirming ? (
            <div className={styles.confirm} role="group" aria-label={`Confirmar revogação de ${token.name}`}>
              <span>Quem usa este token perde o acesso.</span>
              <button type="button" className="btn btn-danger btn-sm" onClick={() => revoke.mutate()} disabled={revoke.isPending}>
                Confirmar revogação
              </button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setConfirming(false)}>
                Manter
              </button>
              {revoke.isError && (
                <span className={styles.error} role="alert">
                  {errorMessage(revoke.error)}
                </span>
              )}
            </div>
          ) : (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setConfirming(true)}
              aria-label={`Revogar ${token.name}`}
            >
              Revogar
            </button>
          ))}
      </td>
    </tr>
  )
}
