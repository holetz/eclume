import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, useState, type FormEvent } from 'react'
import { api, type Schemas } from '../../api/client'
import { errorMessage, unwrap } from '../../api/problem'
import { usePageTitle } from '../../app/usePageTitle'
import styles from './Admin.module.css'
import { labelOf, NEEDS_BASE_URL, PROVIDER_KINDS } from './labels'
import { PROVIDERS_KEY, SETTINGS_KEY, useAdminSettings, useProviders, useUpdateSettings } from './queries'
import { sectionTitle } from './sections'

type Provider = Schemas['AgentProvider']
type ProviderKind = Schemas['AgentProviderKind']

/** Providers de agente de sumarização (da #9) e o provider padrão da organização. */
export function AgentsPage() {
  usePageTitle(sectionTitle('agentes'))
  const providers = useProviders()
  const [editing, setEditing] = useState<Provider | 'new' | null>(null)
  const items = providers.data?.items ?? []

  return (
    <section className={styles.page} aria-labelledby="agentes-titulo">
      <div className={styles.intro}>
        <h2 id="agentes-titulo">Agentes de sumarização</h2>
        <p className="muted">
          Onde os resumos são gerados. As chaves de API ficam cifradas no servidor e nunca voltam para a tela.
        </p>
      </div>
      <DefaultProvider providers={items} />
      <section className={styles.section} aria-labelledby="providers-lista">
        <div className={styles.actions}>
          <h3 id="providers-lista">Providers cadastrados</h3>
          {editing === null && (
            <button type="button" className="btn btn-sm" onClick={() => setEditing('new')}>
              Cadastrar provider
            </button>
          )}
        </div>
        {editing !== null && (
          <ProviderForm
            key={editing === 'new' ? 'novo' : editing.id}
            provider={editing === 'new' ? null : editing}
            onDone={() => setEditing(null)}
          />
        )}
        {providers.isPending && <p role="status">Carregando providers…</p>}
        {providers.isError && (
          <p className="alert alert-error" role="alert">
            {errorMessage(providers.error)}
          </p>
        )}
        {providers.isSuccess && items.length === 0 && (
          <p className="muted">Nenhum provider cadastrado: os resumos não rodam até haver um.</p>
        )}
        {items.length > 0 && (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Nome</th>
                  <th scope="col">Tipo</th>
                  <th scope="col">Modelo</th>
                  <th scope="col">Chave</th>
                  <th scope="col">Estado</th>
                  <th scope="col">
                    <span className="visually-hidden">Ações</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((provider) => (
                  <ProviderRow key={provider.id} provider={provider} onEdit={() => setEditing(provider)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </section>
  )
}

function DefaultProvider({ providers }: { providers: Provider[] }) {
  const settings = useAdminSettings()
  const update = useUpdateSettings()
  const selectId = useId()
  const current = settings.data?.summarization.default_provider_id ?? ''
  const enabled = providers.filter((provider) => provider.enabled)

  return (
    <div className={`card ${styles.form}`}>
      <div className="field">
        <label htmlFor={selectId}>Provider padrão</label>
        <select
          id={selectId}
          className="select"
          value={current}
          disabled={!settings.data || update.isPending}
          onChange={(e) => update.mutate({ summarization: { default_provider_id: e.target.value || null } })}
        >
          <option value="">Nenhum (resumos só com provider escolhido)</option>
          {enabled.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.name}
            </option>
          ))}
        </select>
        <span className="hint">Usado no resumo automático e quando o usuário não escolhe outro.</span>
      </div>
      {update.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(update.error)}
        </p>
      )}
      <span role="status" className={styles.meta}>
        {update.isSuccess ? 'Provider padrão salvo.' : ''}
      </span>
    </div>
  )
}

function ProviderForm({ provider, onDone }: { provider: Provider | null; onDone: () => void }) {
  const queryClient = useQueryClient()
  const [name, setName] = useState(provider?.name ?? '')
  const [kind, setKind] = useState<ProviderKind>(provider?.kind ?? 'claude-cli')
  const [model, setModel] = useState(provider?.model ?? '')
  const [baseUrl, setBaseUrl] = useState(provider?.base_url ?? '')
  const [apiKey, setApiKey] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const [enabled, setEnabled] = useState(provider?.enabled ?? true)
  const ids = { name: useId(), kind: useId(), model: useId(), url: useId(), key: useId() }
  const needsUrl = NEEDS_BASE_URL.has(kind)

  const save = useMutation({
    mutationFn: () => {
      const common = {
        name: name.trim(),
        model: model.trim(),
        base_url: needsUrl ? baseUrl.trim() : null,
        enabled,
      }
      if (provider === null) {
        return unwrap(
          api.POST('/api/v1/admin/agent-providers', {
            body: { ...common, kind, ...(apiKey ? { api_key: apiKey } : {}) },
          }),
        )
      }
      const key = clearKey ? { api_key: null } : apiKey ? { api_key: apiKey } : {}
      return unwrap(
        api.PATCH('/api/v1/admin/agent-providers/{provider_id}', {
          params: { path: { provider_id: provider.id } },
          body: { ...common, ...key },
        }),
      )
    },
    onSuccess: () => {
      // Criar o primeiro provider pode torná-lo o padrão da organização.
      void queryClient.invalidateQueries({ queryKey: PROVIDERS_KEY })
      void queryClient.invalidateQueries({ queryKey: SETTINGS_KEY })
      onDone()
    },
  })

  function submit(event: FormEvent) {
    event.preventDefault()
    save.mutate()
  }

  const title = provider ? `Editar “${provider.name}”` : 'Novo provider'
  return (
    <form className={`card ${styles.form}`} onSubmit={submit} aria-label={title}>
      <h4>{title}</h4>
      <div className={styles.row}>
        <div className="field">
          <label htmlFor={ids.name}>Nome</label>
          <input id={ids.name} className="input" required value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={ids.kind}>Tipo</label>
          <select
            id={ids.kind}
            className="select"
            value={kind}
            disabled={provider !== null}
            onChange={(e) => setKind(e.target.value as ProviderKind)}
          >
            {PROVIDER_KINDS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={ids.model}>Modelo</label>
          <input
            id={ids.model}
            className="input"
            required
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="Ex.: sonnet, deepseek-chat"
          />
        </div>
      </div>
      <span className="hint">{PROVIDER_KINDS.find((option) => option.value === kind)?.hint}</span>
      {needsUrl && (
        <div className="field">
          <label htmlFor={ids.url}>Endereço da API</label>
          <input
            id={ids.url}
            className="input"
            type="url"
            required
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.deepseek.com/v1"
          />
        </div>
      )}
      <div className="field">
        <label htmlFor={ids.key}>Chave de API</label>
        <input
          id={ids.key}
          className="input"
          type="password"
          autoComplete="off"
          value={apiKey}
          disabled={clearKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={provider?.api_key_set ? 'Guardada — deixe em branco para manter' : 'Opcional'}
        />
      </div>
      {provider?.api_key_set && (
        <label className={styles.check}>
          <input type="checkbox" checked={clearKey} onChange={(e) => setClearKey(e.target.checked)} />
          <span>Apagar a chave guardada</span>
        </label>
      )}
      <label className={styles.check}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <span>Habilitado</span>
      </label>
      {save.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(save.error)}
        </p>
      )}
      <div className={styles.actions}>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={save.isPending || !name.trim() || !model.trim() || (needsUrl && !baseUrl.trim())}
        >
          {save.isPending ? 'Salvando…' : provider ? 'Salvar alterações' : 'Cadastrar'}
        </button>
        <button type="button" className="btn" onClick={onDone}>
          Cancelar
        </button>
      </div>
    </form>
  )
}

function ProviderRow({ provider, onEdit }: { provider: Provider; onEdit: () => void }) {
  const queryClient = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const remove = useMutation({
    mutationFn: () =>
      unwrap(
        api.DELETE('/api/v1/admin/agent-providers/{provider_id}', { params: { path: { provider_id: provider.id } } }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PROVIDERS_KEY })
      void queryClient.invalidateQueries({ queryKey: SETTINGS_KEY })
    },
  })
  return (
    <tr data-muted={!provider.enabled}>
      <th scope="row">
        <span className={styles.strong}>{provider.name}</span>
        {provider.base_url && <span className={styles.mono}>{provider.base_url}</span>}
      </th>
      <td>{labelOf(PROVIDER_KINDS, provider.kind)}</td>
      <td className={styles.mono}>{provider.model}</td>
      <td>{provider.api_key_set ? 'Guardada' : 'Sem chave'}</td>
      <td>
        {provider.enabled ? (
          <span className="badge badge-success">Habilitado</span>
        ) : (
          <span className="badge badge-neutral">Desabilitado</span>
        )}
      </td>
      <td className={styles.actionsCell}>
        {confirming ? (
          <div className={styles.confirm} role="group" aria-label={`Confirmar exclusão de ${provider.name}`}>
            <span>Resumos já gerados continuam.</span>
            <button type="button" className="btn btn-danger btn-sm" onClick={() => remove.mutate()} disabled={remove.isPending}>
              Confirmar exclusão
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setConfirming(false)}>
              Manter
            </button>
            {remove.isError && (
              <span className={styles.error} role="alert">
                {errorMessage(remove.error)}
              </span>
            )}
          </div>
        ) : (
          <div className={styles.actions}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onEdit} aria-label={`Editar ${provider.name}`}>
              Editar
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setConfirming(true)}
              aria-label={`Excluir ${provider.name}`}
            >
              Excluir
            </button>
          </div>
        )}
      </td>
    </tr>
  )
}
