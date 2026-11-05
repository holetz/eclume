import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { Trans, useTranslation } from 'react-i18next'
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
  const { t } = useTranslation('tokens')
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
  const sorted = [...items.filter((token) => !token.revoked_at), ...items.filter((token) => token.revoked_at)]

  return (
    <section className={styles.page}>
      <PageHead
        kicker={t('page.kicker')}
        title={t('page.title')}
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
            {t('page.new')}
          </button>
        }
      />
      <p className={`text-muted ${styles.lead}`}>
        <Trans
          t={t}
          i18nKey="page.lead"
          components={{
            api: <a href="/referencia-api.html" />,
            mcp: <Link to="/config/mcp" />,
          }}
        />
      </p>

      {created && <CreatedAlert created={created} onDone={() => setCreated(null)} />}

      {tokens.isPending && <p role="status">{t('page.loading')}</p>}
      {tokens.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(tokens.error)}
        </p>
      )}
      {tokens.isSuccess && items.length === 0 && <p className="text-muted">{t('page.empty')}</p>}
      {items.length > 0 && (
        <div className={styles.tableWrap}>
          <table className="table">
            <thead>
              <tr>
                <th scope="col">{t('page.name')}</th>
                <th scope="col">{t('page.scopes')}</th>
                <th scope="col">{t('page.expiry')}</th>
                <th scope="col">{t('page.lastUsed')}</th>
                <th scope="col">
                  <span className="visually-hidden">{t('page.actions')}</span>
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
            {t('page.more')}
          </button>
        </div>
      )}

      {creating && (
        <Dialog title={t('page.new')} onClose={() => setCreating(false)} size="lg" plain>
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
  const { t } = useTranslation('tokens')
  const region = useRef<HTMLDivElement>(null)
  useEffect(() => region.current?.focus(), [])

  return (
    <div
      ref={region}
      tabIndex={-1}
      role="region"
      aria-label={t('page.created', { name: created.token.name })}
      className={`alert alert-success ${styles.created}`}
    >
      <span className="alert-title">{t('page.createdCopy')}</span>
      <span>{t('page.once')}</span>
      <div className={styles.secret}>
        <CopyValue value={created.secret} />
      </div>
      <div>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onDone}>
          {t('page.done')}
        </button>
      </div>
    </div>
  )
}

function TokenRow({ token, onRevoke }: { token: Token; onRevoke: () => void }) {
  const { t } = useTranslation('tokens')
  const expired = token.expires_at !== null && new Date(token.expires_at) < new Date()

  return (
    <tr className={token.revoked_at ? styles.revoked : undefined}>
      <td>
        <strong>{token.name}</strong>
        {token.kind === 'device' && (
          <span className={`badge ${styles.deviceBadge}`}>
            {token.platform
              ? t('page.devicePlatform', { platform: PLATFORM_LABELS[token.platform] })
              : t('page.device')}
          </span>
        )}
      </td>
      <td className={`mono ${styles.scopes}`} title={token.scopes.join(', ')}>
        {summarizeScopes(token.scopes)}
      </td>
      <td className="tabular">
        {token.revoked_at ? (
          t('page.revokedOn', { date: formatDate(token.revoked_at) })
        ) : expired ? (
          <span className="badge badge-warning">{t('page.expired')}</span>
        ) : token.expires_at ? (
          formatDate(token.expires_at)
        ) : (
          t('page.never')
        )}
      </td>
      <td className="tabular text-muted">{token.last_used_at ? formatDateTime(token.last_used_at) : t('page.neverUsed')}</td>
      <td className={styles.actions}>
        {!token.revoked_at && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onRevoke} aria-label={t('page.revokeName', { name: token.name })}>
            {t('page.revoke')}
          </button>
        )}
      </td>
    </tr>
  )
}

function RevokeDialog({ token, onClose }: { token: Token; onClose: () => void }) {
  const { t } = useTranslation('tokens')
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
      title={t('page.revokeTitle', { name: token.name })}
      confirmLabel={t('page.revoke')}
      onConfirm={() => revoke.mutate()}
      onCancel={onClose}
      busy={revoke.isPending}
    >
      {token.kind === 'device'
        ? t('page.revokeDevice')
        : t('page.revokeToken')}
      {revoke.isError && (
        <span className="alert alert-error" role="alert">
          {errorMessage(revoke.error)}
        </span>
      )}
    </ConfirmDialog>
  )
}
