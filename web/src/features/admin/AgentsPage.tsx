import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, useState, type FormEvent } from 'react'
import { api, type Schemas } from '../../api/client'
import { errorMessage, unwrap } from '../../api/problem'
import { ConfirmDialog } from '../../app/ConfirmDialog'
import { AdminPageHead } from './AdminPageHead'
import styles from './Admin.module.css'
import { labelOf, MODEL_PLACEHOLDERS, NEEDS_BASE_URL, PROVIDER_KINDS, providerSecret, PURPOSES, SECRET_INFO } from './labels'
import { PROVIDERS_KEY, usePlatformSecret, useProviders, useSecrets } from './queries'
import { SecretField } from './SecretField'
import { Switch } from '../../shared/Switch'

type Provider = Schemas['AgentProvider']
type ProviderKind = Schemas['AgentProviderKind']
type Purpose = Schemas['AgentPurpose']

const ANTHROPIC_KEY = 'anthropic_api_key'

const purposeLabel = (purpose: string) => labelOf(PURPOSES, purpose).toLocaleLowerCase('pt-BR')

/** O aviso de segredo faltando; o `anthropic` sem chave própria usa a compartilhada. */
function missingSecret(provider: Provider, sharedKeySet: boolean): string | null {
  if (provider.api_key_set || provider.kind === 'ollama') return null
  if (provider.kind === 'anthropic' && sharedKeySet) return null
  return providerSecret(provider.kind).missing
}

/** Providers de agente da plataforma, para que cada um serve e os segredos que usam. */
export function AgentsPage() {
  const providers = useProviders()
  const secrets = useSecrets()
  const shared = usePlatformSecret(ANTHROPIC_KEY)
  const [editing, setEditing] = useState<string | 'new' | null>(null)
  const items = providers.data?.items ?? []
  const anthropic = secrets.data?.items.find((secret) => secret.name === ANTHROPIC_KEY)
  const sharedKeySet = anthropic?.is_set ?? false
  // Relido da lista: depois de gravar o segredo, o painel mostra o estado novo.
  const current = editing === 'new' ? null : items.find((provider) => provider.id === editing)
  const owners = new Map(items.flatMap((provider) => provider.used_for.map((purpose) => [purpose, provider] as const)))
  const orphans = PURPOSES.filter((purpose) => !owners.get(purpose.value as Purpose)?.enabled)

  return (
    <>
      <AdminPageHead
        title="Agentes"
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>
            Cadastrar provider
          </button>
        }
      />
      <p className={`text-muted ${styles.lede}`}>
        Providers de IA usados nos resumos, no preenchimento de campos, na detecção do tipo de agenda e no chat do
        resumo.
      </p>
      {providers.isPending && <p role="status">Carregando providers…</p>}
      {providers.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(providers.error)}
        </p>
      )}
      {providers.isSuccess && orphans.length > 0 && (
        <p className="alert alert-warning">
          Sem provider para: {orphans.map((purpose) => purpose.label.toLocaleLowerCase('pt-BR')).join(', ')}.
        </p>
      )}
      {providers.isSuccess && items.length === 0 && <p className="text-muted">Nenhum provider cadastrado.</p>}
      {items.length > 0 && (
        <div className="list" aria-label="Providers cadastrados" role="list">
          {items.map((provider) => (
            <ProviderRow
              key={provider.id}
              provider={provider}
              missing={missingSecret(provider, sharedKeySet)}
              onEdit={() => setEditing(provider.id)}
            />
          ))}
        </div>
      )}
      {editing !== null && current !== undefined && (
        <ProviderPanel
          key={editing}
          provider={current}
          owners={owners}
          onDone={() => setEditing(null)}
        />
      )}
      <section className={`${styles.stack} ${styles.sharedKey}`} aria-labelledby="agentes-chave-anthropic">
        <h2 id="agentes-chave-anthropic" className={styles.sectionTitle}>
          Chave compartilhada da API da Anthropic
        </h2>
        {anthropic ? (
          <SecretField
            label={SECRET_INFO[ANTHROPIC_KEY].label}
            isSet={anthropic.is_set}
            updatedAt={anthropic.updated_at}
            hint={SECRET_INFO[ANTHROPIC_KEY].hint}
            onSave={(value) => shared.save.mutateAsync(value)}
            onClear={() => shared.clear.mutateAsync()}
          />
        ) : secrets.isError ? (
          <p className="alert alert-error" role="alert">
            {errorMessage(secrets.error)}
          </p>
        ) : (
          <p role="status">Carregando…</p>
        )}
      </section>
    </>
  )
}

function ProviderRow({ provider, missing, onEdit }: { provider: Provider; missing: string | null; onEdit: () => void }) {
  const purposes = provider.used_for.length > 0 ? provider.used_for.map(purposeLabel).join(', ') : 'sem uso'
  const sub = [labelOf(PROVIDER_KINDS, provider.kind), provider.base_url, purposes].filter(Boolean).join(' · ')
  return (
    <div className="list-row" role="listitem">
      <span className="list-row-title">{provider.name}</span>
      <span className="list-row-sub">{sub}</span>
      <span className="list-row-actions">
        {provider.enabled ? (
          <span className="badge badge-success">Habilitado</span>
        ) : (
          <span className="badge">Desligado</span>
        )}
        {missing && <span className="badge badge-warning">{missing}</span>}
        <button type="button" className="btn btn-secondary btn-sm" onClick={onEdit} aria-label={`Editar ${provider.name}`}>
          Editar
        </button>
      </span>
    </div>
  )
}

interface ProviderPanelProps {
  provider: Provider | null
  owners: Map<Purpose, Provider>
  onDone: () => void
}

function ProviderPanel({ provider, owners, onDone }: ProviderPanelProps) {
  const queryClient = useQueryClient()
  const [name, setName] = useState(provider?.name ?? '')
  const [kind, setKind] = useState<ProviderKind>(provider?.kind ?? 'claude-cli')
  const [model, setModel] = useState(provider?.model ?? '')
  const [baseUrl, setBaseUrl] = useState(provider?.base_url ?? '')
  const [apiKey, setApiKey] = useState('')
  const [enabled, setEnabled] = useState(provider?.enabled ?? true)
  // Um provider novo assume, marcadas, as finalidades que ninguém tem (o que o server faria sem `used_for`).
  const [usedFor, setUsedFor] = useState<Purpose[]>(
    () => provider?.used_for ?? PURPOSES.map((p) => p.value as Purpose).filter((purpose) => !owners.has(purpose)),
  )
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const ids = { name: useId(), kind: useId(), model: useId(), url: useId(), key: useId(), help: useId(), used: useId() }
  const needsUrl = NEEDS_BASE_URL.has(kind)
  const secret = providerSecret(kind)
  const refresh = () => queryClient.invalidateQueries({ queryKey: PROVIDERS_KEY })
  const path = provider ? { params: { path: { provider_id: provider.id } } } : null

  const save = useMutation({
    mutationFn: () => {
      const common = {
        name: name.trim(),
        model: model.trim(),
        base_url: needsUrl ? baseUrl.trim() : null,
        enabled,
        used_for: usedFor,
      }
      if (path === null) {
        return unwrap(
          api.POST('/api/v1/admin/agent-providers', {
            body: { ...common, kind, ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}) },
          }),
        )
      }
      return unwrap(api.PATCH('/api/v1/admin/agent-providers/{provider_id}', { ...path, body: common }))
    },
    onSuccess: async () => {
      await refresh()
      onDone()
    },
  })

  const patchKey = (api_key: string | null) =>
    unwrap(api.PATCH('/api/v1/admin/agent-providers/{provider_id}', { ...path!, body: { api_key } })).then(refresh)

  const remove = useMutation({
    mutationFn: () => unwrap(api.DELETE('/api/v1/admin/agent-providers/{provider_id}', path!)),
    onSuccess: async () => {
      await refresh()
      onDone()
    },
  })

  function toggle(purpose: Purpose, checked: boolean) {
    setUsedFor((current) => (checked ? [...current, purpose] : current.filter((p) => p !== purpose)))
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    save.mutate()
  }

  const title = provider?.name ?? 'Novo provider'
  const canSave = !save.isPending && name.trim() !== '' && model.trim() !== '' && (!needsUrl || baseUrl.trim() !== '')
  return (
    <form className={`panel ${styles.providerPanel}`} onSubmit={submit} aria-label={provider ? `Editar ${title}` : title}>
      <h4>{title}</h4>
      <div className="field">
        <label htmlFor={ids.name}>Nome</label>
        <input id={ids.name} className="input" required value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={ids.kind}>Tipo</label>
        {provider ? (
          <input id={ids.kind} className="input" readOnly value={labelOf(PROVIDER_KINDS, kind)} />
        ) : (
          <select id={ids.kind} className="input" value={kind} onChange={(e) => setKind(e.target.value as ProviderKind)}>
            {PROVIDER_KINDS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        )}
        <span className="field-hint">{PROVIDER_KINDS.find((option) => option.value === kind)?.hint}</span>
      </div>
      <div className="field">
        <label htmlFor={ids.model}>Modelo</label>
        <input
          id={ids.model}
          className="input"
          required
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder={MODEL_PLACEHOLDERS[kind]}
        />
      </div>
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
      {provider ? (
        <SecretField
          label={secret.label}
          isSet={provider.api_key_set}
          updatedAt={null}
          hint={secret.help}
          onSave={(value) => patchKey(value)}
          onClear={() => patchKey(null)}
        />
      ) : (
        <div className="field">
          <label htmlFor={ids.key}>{secret.label}</label>
          <input
            id={ids.key}
            className="input"
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            aria-describedby={secret.help ? ids.help : undefined}
            placeholder="Opcional"
          />
          {secret.help && (
            <span id={ids.help} className="field-hint">
              {secret.help}
            </span>
          )}
        </div>
      )}
      <fieldset className={styles.fieldset} aria-describedby={ids.used}>
        <legend className={styles.label}>Usado para</legend>
        <div className={styles.checks}>
          {PURPOSES.map((option) => {
            const purpose = option.value as Purpose
            const owner = owners.get(purpose)
            const elsewhere = owner && owner.id !== provider?.id ? owner : null
            return (
              <label key={purpose} className="check">
                <input
                  type="checkbox"
                  checked={usedFor.includes(purpose)}
                  onChange={(e) => toggle(purpose, e.target.checked)}
                />
                <span className="box" />
                <span>
                  {option.label}
                  {elsewhere && <span className={`text-muted ${styles.small}`}> · hoje com {elsewhere.name}</span>}
                </span>
              </label>
            )
          })}
        </div>
        <span id={ids.used} className="field-hint">
          Cada finalidade tem um provider só: marcar aqui tira do outro.
        </span>
      </fieldset>
      <Switch checked={enabled} onChange={setEnabled}>
        Habilitado
      </Switch>
      {(save.isError || remove.isError) && (
        <p className="alert alert-error" role="alert">
          {errorMessage(save.error ?? remove.error)}
        </p>
      )}
      <div className={styles.row}>
        <button type="submit" className="btn btn-primary" disabled={!canSave}>
          {save.isPending ? 'Salvando…' : 'Salvar'}
        </button>
        <button type="button" className="btn btn-secondary" onClick={onDone}>
          Cancelar
        </button>
        {provider && (
          <button type="button" className="btn btn-ghost" onClick={() => setConfirmingDelete(true)}>
            Excluir provider
          </button>
        )}
      </div>
      {confirmingDelete && (
        <ConfirmDialog
          title={`Excluir ${title}?`}
          confirmLabel="Excluir"
          busy={remove.isPending}
          onConfirm={() => remove.mutate()}
          onCancel={() => setConfirmingDelete(false)}
        >
          Os resumos já gerados continuam.
        </ConfirmDialog>
      )}
    </form>
  )
}
