import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { api, type Schemas } from '../../api/client'
import { errorMessage, unwrap } from '../../api/problem'
import { ConfirmDialog } from '../../app/ConfirmDialog'
import { CopyValue } from '../../app/CopyValue'
import { Dialog } from '../../app/Dialog'
import { useHelpTopic } from '../../app/help'
import { PageHead } from '../../app/PageHead'

import { PLATFORM_LABELS, summarizeScopes, TOKENS_KEY } from './scopes'
import { TokenForm } from './TokenForm'
import styles from './TokensPage.module.css'
import { formatDate, formatDateTime } from '../../shared/format'

type Token = Schemas['Token']

export function TokensPage() {
  useHelpTopic('tokens')
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState<Schemas['TokenCreated'] | null>(null)
  const [revoking, setRevoking] = useState<Token | null>(null)
  const tokens = useInfiniteQuery({
    queryKey: TOKENS_KEY,
    queryFn: ({ pageParam }) =>
      unwrap(api.GET('/api/v1/tokens', { params: { query: { limit: 50, ...(pageParam ? { cursor: pageParam } : {}) } } })),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
  })
  const items = tokens.data?.pages.flatMap((page) => page.items) ?? []
  // The revoked ones go to the end, in the order they came.
  const sorted = [...items.filter((t) => !t.revoked_at), ...items.filter((t) => t.revoked_at)]

  return (
    <section className={styles.page}>
      <PageHead
        kicker="Minhas configurações"
        title="Tokens de acesso"
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
            Novo token
          </button>
        }
      />
      <p className={`text-muted ${styles.lead}`}>
        Um token dá acesso à API em seu nome, limitado aos escopos escolhidos. Trate-o como uma senha. As rotas,
        os escopos de cada uma e os formatos estão na <a href="/referencia-api.html">Referência da API</a>. Para
        assistentes de IA, use <Link to="/config/mcp">Conexão MCP</Link>. O app desktop e o celular entram com
        e-mail e senha ou com um código.
      </p>

      {created && <CreatedAlert created={created} onDone={() => setCreated(null)} />}

      {tokens.isPending && <p role="status">Carregando tokens…</p>}
      {tokens.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(tokens.error)}
        </p>
      )}
      {tokens.isSuccess && items.length === 0 && <p className="text-muted">Você ainda não criou nenhum token.</p>}
      {items.length > 0 && (
        <div className={styles.tableWrap}>
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Nome</th>
                <th scope="col">Escopos</th>
                <th scope="col">Validade</th>
                <th scope="col">Último uso</th>
                <th scope="col">
                  <span className="visually-hidden">Ações</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((token) => (
                <TokenRow key={token.id} token={token} onRevoke={() => setRevoking(token)} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {tokens.hasNextPage && (
        <div>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => tokens.fetchNextPage()}
            disabled={tokens.isFetchingNextPage}
          >
            Carregar mais
          </button>
        </div>
      )}

      {creating && (
        <Dialog title="Novo token" onClose={() => setCreating(false)} size="lg" plain>
          <TokenForm
            showIndividual
            onCancel={() => setCreating(false)}
            onCreated={(result) => {
              setCreating(false)
              setCreated(result)
            }}
          />
        </Dialog>
      )}
      {revoking && <RevokeDialog token={revoking} onClose={() => setRevoking(null)} />}
    </section>
  )
}

function CreatedAlert({ created, onDone }: { created: Schemas['TokenCreated']; onDone: () => void }) {
  const region = useRef<HTMLDivElement>(null)
  useEffect(() => region.current?.focus(), [])

  return (
    <div
      ref={region}
      tabIndex={-1}
      role="region"
      aria-label={`Token “${created.token.name}” criado`}
      className={`alert alert-success ${styles.created}`}
    >
      <span className="alert-title">Token criado · copie agora</span>
      <span>Ele só aparece uma vez.</span>
      <div className={styles.secret}>
        <CopyValue value={created.secret} />
      </div>
      <div>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onDone}>
          Pronto, já guardei
        </button>
      </div>
    </div>
  )
}

function TokenRow({ token, onRevoke }: { token: Token; onRevoke: () => void }) {
  const expired = token.expires_at !== null && new Date(token.expires_at) < new Date()

  return (
    <tr className={token.revoked_at ? styles.revoked : undefined}>
      <td>
        <strong>{token.name}</strong>
        {token.kind === 'device' && (
          <span className={`badge ${styles.deviceBadge}`}>
            Aparelho{token.platform ? ` · ${PLATFORM_LABELS[token.platform]}` : ''}
          </span>
        )}
      </td>
      <td className={`mono ${styles.scopes}`} title={token.scopes.join(', ')}>
        {summarizeScopes(token.scopes)}
      </td>
      <td className="tabular">
        {token.revoked_at ? (
          `Revogado em ${formatDate(token.revoked_at)}`
        ) : expired ? (
          <span className="badge badge-warning">Expirado</span>
        ) : token.expires_at ? (
          formatDate(token.expires_at)
        ) : (
          'Nunca'
        )}
      </td>
      <td className="tabular text-muted">{token.last_used_at ? formatDateTime(token.last_used_at) : 'Nunca usado'}</td>
      <td className={styles.actions}>
        {!token.revoked_at && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onRevoke} aria-label={`Revogar ${token.name}`}>
            Revogar
          </button>
        )}
      </td>
    </tr>
  )
}

function RevokeDialog({ token, onClose }: { token: Token; onClose: () => void }) {
  const queryClient = useQueryClient()
  const revoke = useMutation({
    mutationFn: () => unwrap(api.DELETE('/api/v1/tokens/{token_id}', { params: { path: { token_id: token.id } } })),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: TOKENS_KEY })
      onClose()
    },
  })
  return (
    <ConfirmDialog
      title={`Revogar ${token.name}?`}
      confirmLabel="Revogar"
      onConfirm={() => revoke.mutate()}
      onCancel={onClose}
      busy={revoke.isPending}
    >
      {token.kind === 'device'
        ? 'O aparelho para de sincronizar até entrar de novo.'
        : 'Quem usa este token perde o acesso.'}
      {revoke.isError && (
        <span className="alert alert-error" role="alert">
          {errorMessage(revoke.error)}
        </span>
      )}
    </ConfirmDialog>
  )
}
