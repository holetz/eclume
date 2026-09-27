import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
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

// Os três primeiros grupos marcados; "Excluir gravações" fica desmarcado.
const ASSISTANT_DEFAULTS: { name: string; scopes: Scope[]; expiration: string } = {
  name: 'Claude Desktop',
  scopes: ['recordings:read', 'transcripts:read', 'summaries:read', 'summaries:write', 'recordings:write'],
  expiration: '90',
}

export function McpPage() {
  useHelpTopic('mcp')
  const server = useServerInfo()
  const [created, setCreated] = useState<Schemas['TokenCreated'] | null>(null)
  const mcpUrl = server.data?.mcp_url

  return (
    <section className={styles.page}>
      <PageHead kicker="Minhas configurações" title="Conexão MCP" />
      <div className={`split ${styles.split}`}>
        <ol className="steps">
          <li>
            <strong>Copie o endereço do servidor</strong>
            {mcpUrl ? (
              <div className={styles.stepBlock}>
                <CopyValue value={mcpUrl} />
              </div>
            ) : server.isError ? (
              <span className="alert alert-error" role="alert">
                {errorMessage(server.error)}
              </span>
            ) : (
              <span role="status">Carregando o endereço…</span>
            )}
          </li>
          <li>
            <strong>Crie um token para o assistente</strong>
            <span className="text-muted">
              Escolha o que ele pode fazer. Você revoga quando quiser em{' '}
              <Link to="/tokens">Tokens de acesso</Link>.
            </span>
          </li>
          <li>
            <strong>Adicione o eclume ao seu assistente</strong>
            <span className="text-muted">
              Cole o endereço e o token nas configurações de conectores dele e pergunte: “O que decidimos no
              planejamento da semana passada?” <Link to="/ajuda/conectar-assistente-mcp">Como conectar</Link>
            </span>
          </li>
        </ol>

        <div className="panel" role="region" aria-labelledby="mcp-novo-token">
          <h4 id="mcp-novo-token" className={styles.panelTitle}>
            Novo token para um assistente
          </h4>
          {created ? (
            <CreatedToken created={created} mcpUrl={mcpUrl} onAnother={() => setCreated(null)} />
          ) : (
            <TokenForm
              defaults={ASSISTANT_DEFAULTS}
              groupHints={{
                excluir: (
                  <HelpHint subject="excluir gravações" title="Excluir gravações" article="conectar-assistente-mcp">
                    Um assistente com este escopo pode apagar gravações se a transcrição pedir. Deixe desligado se
                    não precisar.
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
  // O formulário que tinha o foco sai da tela: o foco vai para o aviso, e o leitor de tela o lê.
  const region = useRef<HTMLDivElement>(null)
  useEffect(() => region.current?.focus(), [])
  return (
    <div
      ref={region}
      tabIndex={-1}
      role="region"
      aria-label={`Token “${created.token.name}” criado`}
      className={styles.created}
    >
      <div className="alert alert-success">
        <span className="alert-title">Token “{created.token.name}” criado · copie agora</span>
        <span>Ele só aparece uma vez.</span>
      </div>
      <CopyValue value={created.secret} />
      {mcpUrl && (
        <>
          <span className={styles.label}>No Claude Code:</span>
          <CopyValue
            value={`claude mcp add --transport http eclume ${mcpUrl} --header "Authorization: Bearer ${created.secret}"`}
          />
        </>
      )}
      <p className="field-hint">
        O computador do assistente precisa confiar no certificado deste servidor.{' '}
        <Link to="/ajuda/certificado-do-servidor">Como instalar o certificado</Link>
      </p>
      <div>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onAnother}>
          Criar outro token
        </button>
      </div>
    </div>
  )
}
