import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { Trans, useTranslation } from 'react-i18next'
import type { Schemas } from '../../api/client'
import { errorMessage } from '../../api/problem'
import { CopyValue } from '../../app/CopyValue'
import { useHelpTopic } from '../../app/help'
import { HelpHint } from '../../app/HelpHint'
import { PageHead } from '../../app/PageHead'
import type { Scope } from '../tokens/scopes'
import { TokenForm } from '../tokens/TokenForm'
import styles from './Connect.module.css'
import { useServerInfo } from './serverInfo'

// The first three groups checked; deleting recordings stays unchecked.
const ASSISTANT_DEFAULTS: { name: string; scopes: Scope[]; expiration: string } = {
  name: 'Claude Desktop',
  scopes: ['recordings:read', 'transcripts:read', 'summaries:read', 'summaries:write', 'recordings:write'],
  expiration: '90',
}

export function McpPage() {
  useHelpTopic('mcp')
  const { t } = useTranslation(['connect', 'shell'])
  const server = useServerInfo()
  const [created, setCreated] = useState<Schemas['TokenCreated'] | null>(null)
  const mcpUrl = server.data?.mcp_url

  return (
    <section className={styles.page}>
      <PageHead kicker={t('kicker')} title={t('mcp.title')} />
      <div className={`split ${styles.split}`}>
        <ol className="steps">
          <li>
            <strong>{t('mcp.copyAddress')}</strong>
            {mcpUrl ? (
              <div className={styles.stepBlock}>
                <CopyValue value={mcpUrl} />
              </div>
            ) : server.isError ? (
              <span className="alert alert-error" role="alert">
                {errorMessage(server.error)}
              </span>
            ) : (
              <span role="status">{t('mcp.loadingAddress')}</span>
            )}
          </li>
          <li>
            <strong>{t('mcp.createToken')}</strong>
            <span className="text-muted">
              <Trans t={t} i18nKey="mcp.createTokenText" components={{ tokens: <Link to="/tokens" /> }} />
            </span>
          </li>
          <li>
            <strong>{t('mcp.addEclume')}</strong>
            <span className="text-muted">
              <Trans
                t={t}
                i18nKey="mcp.addEclumeText"
                components={{ help: <Link to="/ajuda/connect-mcp-assistant" /> }}
              />
            </span>
          </li>
        </ol>

        <div className="panel" role="region" aria-labelledby="mcp-novo-token">
          <h4 id="mcp-novo-token" className={styles.panelTitle}>
            {t('mcp.newToken')}
          </h4>
          {created ? (
            <CreatedToken created={created} mcpUrl={mcpUrl} onAnother={() => setCreated(null)} />
          ) : (
            <TokenForm
              defaults={ASSISTANT_DEFAULTS}
              groupHints={{
                excluir: (
                  <HelpHint subject={t('mcp.deleteSubject')} title={t('mcp.deleteTitle')} article="connect-mcp-assistant">
                    {t('mcp.deleteHint')}
                  </HelpHint>
                ),
              }}
              onCreated={setCreated}
            />
          )}
        </div>
      </div>
    </section>
  )
}

function CreatedToken({
  created,
  mcpUrl,
  onAnother,
}: {
  created: Schemas['TokenCreated']
  mcpUrl: string | undefined
  onAnother: () => void
}) {
  // The form that had focus leaves the screen: focus moves to the notice, and the screen reader reads it.
  const { t } = useTranslation('connect')
  const region = useRef<HTMLDivElement>(null)
  useEffect(() => region.current?.focus(), [])
  return (
    <div
      ref={region}
      tabIndex={-1}
      role="region"
      aria-label={t('mcp.created', { name: created.token.name })}
      className={styles.created}
    >
      <div className="alert alert-success">
        <span className="alert-title">{t('mcp.createdCopy', { name: created.token.name })}</span>
        <span>{t('mcp.once')}</span>
      </div>
      <CopyValue value={created.secret} />
      {mcpUrl && (
        <>
          <span className={styles.label}>{t('mcp.claudeCode')}</span>
          <CopyValue
            value={`claude mcp add --transport http eclume ${mcpUrl} --header "Authorization: Bearer ${created.secret}"`}
          />
        </>
      )}
      <p className="field-hint">
        {t('mcp.certificate')} <Link to="/ajuda/server-certificate">{t('mcp.certificateLink')}</Link>
      </p>
      <div>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onAnother}>
          {t('mcp.another')}
        </button>
      </div>
    </div>
  )
}
