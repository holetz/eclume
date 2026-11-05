import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { api, type Schemas } from '../../api/client'
import { errorMessage, unwrap } from '../../api/problem'
import { ConfirmDialog } from '../../app/ConfirmDialog'
import { AdminPageHead } from './AdminPageHead'
import { ExternalDataNotice } from './ExternalDataNotice'
import styles from './Admin.module.css'
import { labelOf, MODEL_PLACEHOLDERS, NEEDS_BASE_URL, PROVIDER_KINDS, providerSecret, PURPOSES, SECRET_INFO } from './labels'
import { PROVIDERS_KEY, usePlatformSecret, useProviders, useSecrets } from './queries'
import { SecretField } from './SecretField'
import { Switch } from '../../shared/Switch'
import { activeLocale } from '../../i18n'

type Provider = Schemas['AgentProvider']
type ProviderKind = Schemas['AgentProviderKind']
type Purpose = Schemas['AgentPurpose']

const ANTHROPIC_KEY = 'anthropic_api_key'

const purposeLabel = (purpose: string) => labelOf(PURPOSES, purpose).toLocaleLowerCase(activeLocale())

/** The missing-secret notice; `anthropic` without its own key uses the shared one. */
function missingSecret(provider: Provider, sharedKeySet: boolean): string | null {
  if (provider.api_key_set || provider.kind === 'ollama') return null
  if (provider.kind === 'anthropic' && sharedKeySet) return null
  return providerSecret(provider.kind).missing
}

/** The platform's agent providers, what each one serves and the secrets they use. */
export function AgentsPage() {
  const { t } = useTranslation(['admin', 'common'])
  const providers = useProviders()
  const secrets = useSecrets()
  const shared = usePlatformSecret(ANTHROPIC_KEY)
  const [editing, setEditing] = useState<string | 'new' | null>(null)
  const items = providers.data?.items ?? []
  const anthropic = secrets.data?.items.find((secret) => secret.name === ANTHROPIC_KEY)
  const sharedKeySet = anthropic?.is_set ?? false
  // Reread from the list: after saving the secret, the panel shows the new state.
  const current = editing === 'new' ? null : items.find((provider) => provider.id === editing)
  const owners = new Map(items.flatMap((provider) => provider.used_for.map((purpose) => [purpose, provider] as const)))
  const orphans = PURPOSES.filter((purpose) => !owners.get(purpose.value as Purpose)?.enabled)

  return (
    <>
      <AdminPageHead
        title={t('agents.title')}
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>
            {t('agents.add')}
          </button>
        }
      />
      <p className={`text-muted ${styles.lede}`}>
        {t('agents.lede')}
      </p>
      {providers.isPending && <p role="status">{t('agents.loading')}</p>}
      {providers.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(providers.error)}
        </p>
      )}
      {providers.isSuccess && orphans.length > 0 && (
        <p className="alert alert-warning">
          {t('agents.orphans', { list: orphans.map((purpose) => purpose.label.toLocaleLowerCase(activeLocale())).join(', ') })}
        </p>
      )}
      <ExternalDataNotice
        purposes={['summaries', 'fields', 'chat', 'agenda_detection']}
        revision={providers.dataUpdatedAt}
      />
      {providers.isSuccess && items.length === 0 && <p className="text-muted">{t('agents.none')}</p>}
      {items.length > 0 && (
        <div className="list" aria-label={t('agents.list')} role="list">
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
          {t('agents.sharedKey')}
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
          <p role="status">{t('common:loading')}</p>
        )}
      </section>
    </>
  )
}

function ProviderRow({ provider, missing, onEdit }: { provider: Provider; missing: string | null; onEdit: () => void }) {
  const { t } = useTranslation('admin')
  const purposes = provider.used_for.length > 0 ? provider.used_for.map(purposeLabel).join(', ') : t('agents.unused')
  const sub = [labelOf(PROVIDER_KINDS, provider.kind), provider.base_url, purposes].filter(Boolean).join(' · ')
  return (
    <div className="list-row" role="listitem">
      <span className="list-row-title">{provider.name}</span>
      <span className="list-row-sub">{sub}</span>
      <span className="list-row-actions">
        {provider.enabled ? (
          <span className="badge badge-success">{t('agents.enabled')}</span>
        ) : (
          <span className="badge">{t('agents.disabled')}</span>
        )}
        {missing && <span className="badge badge-warning">{missing}</span>}
        <button type="button" className="btn btn-secondary btn-sm" onClick={onEdit} aria-label={t('agents.editName', { name: provider.name })}>
          {t('agents.edit')}
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
  const { t } = useTranslation(['admin', 'common'])
  const queryClient = useQueryClient()
  const [name, setName] = useState(provider?.name ?? '')
  const [kind, setKind] = useState<ProviderKind>(provider?.kind ?? (PROVIDER_KINDS[0].value as ProviderKind))
  const [model, setModel] = useState(provider?.model ?? '')
  const [baseUrl, setBaseUrl] = useState(provider?.base_url ?? '')
  const [apiKey, setApiKey] = useState('')
  const [enabled, setEnabled] = useState(provider?.enabled ?? true)
  // A new provider takes, checked, the purposes nobody has (what the server would do without `used_for`).
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

  const title = provider?.name ?? t('agents.new')
  const canSave = !save.isPending && name.trim() !== '' && model.trim() !== '' && (!needsUrl || baseUrl.trim() !== '')
  return (
    <form className={`panel ${styles.providerPanel}`} onSubmit={submit} aria-label={provider ? t('agents.editName', { name: title }) : title}>
      <h4>{title}</h4>
      <div className="field">
        <label htmlFor={ids.name}>{t('agents.name')}</label>
        <input id={ids.name} className="input" required value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={ids.kind}>{t('agents.kind')}</label>
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
        <label htmlFor={ids.model}>{t('agents.model')}</label>
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
          <label htmlFor={ids.url}>{t('agents.url')}</label>
          <input
            id={ids.url}
            className="input"
            type="url"
            required
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.deepseek.com/v1" // i18n-ignore: a sample address
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
            placeholder={t('agents.optional')}
          />
          {secret.help && (
            <span id={ids.help} className="field-hint">
              {secret.help}
            </span>
          )}
        </div>
      )}
      <fieldset className={styles.fieldset} aria-describedby={ids.used}>
        <legend className={styles.label}>{t('agents.usedFor')}</legend>
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
                  {elsewhere && <span className={`text-muted ${styles.small}`}>{t('agents.elsewhere', { name: elsewhere.name })}</span>}
                </span>
              </label>
            )
          })}
        </div>
        <span id={ids.used} className="field-hint">
          {t('agents.usedForHint')}
        </span>
      </fieldset>
      <Switch checked={enabled} onChange={setEnabled}>
        {t('agents.enabled')}
      </Switch>
      {(save.isError || remove.isError) && (
        <p className="alert alert-error" role="alert">
          {errorMessage(save.error ?? remove.error)}
        </p>
      )}
      <div className={styles.row}>
        <button type="submit" className="btn btn-primary" disabled={!canSave}>
          {save.isPending ? t('settings.saving') : t('settings.save')}
        </button>
        <button type="button" className="btn btn-secondary" onClick={onDone}>
          {t('common:cancel')}
        </button>
        {provider && (
          <button type="button" className="btn btn-ghost" onClick={() => setConfirmingDelete(true)}>
            {t('agents.delete')}
          </button>
        )}
      </div>
      {confirmingDelete && (
        <ConfirmDialog
          title={t('agents.deleteTitle', { name: title })}
          confirmLabel={t('agents.deleteConfirm')}
          busy={remove.isPending}
          onConfirm={() => remove.mutate()}
          onCancel={() => setConfirmingDelete(false)}
        >
          {t('agents.deleteBody')}
        </ConfirmDialog>
      )}
    </form>
  )
}
