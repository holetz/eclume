import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, useState, type FormEvent, type ReactNode } from 'react'
import { api, type Schemas } from '../../api/client'
import { errorMessage, unwrap } from '../../api/problem'
import { HelpHint } from '../../app/HelpHint'
import { EXPIRATIONS, expiresAt, hasGroup, PRESETS, SCOPE_GROUPS, SCOPES, TOKENS_KEY, type Scope } from './scopes'
import styles from './TokensPage.module.css'

interface TokenFormProps {
  defaults?: { name?: string; scopes?: Scope[]; expiration?: string }
  /** Shows the "Escopos individuais" disclosure and the ready-made combinations. */
  showIndividual?: boolean
  /** A hint beside a group, keyed by the group's `id`. */
  groupHints?: Partial<Record<string, ReactNode>>
  onCreated: (created: Schemas['TokenCreated']) => void
  /** With it, the form gains "Cancelar" in the `.dialog-actions`. */
  onCancel?: () => void
}

/** Name, scopes by group and expiry of a personal token; creates it and returns the secret to the caller. */
export function TokenForm({ defaults, showIndividual = false, groupHints, onCreated, onCancel }: TokenFormProps) {
  const queryClient = useQueryClient()
  const [name, setName] = useState(defaults?.name ?? '')
  const [scopes, setScopes] = useState<Scope[]>(defaults?.scopes ?? [])
  const [expiration, setExpiration] = useState(defaults?.expiration ?? '90')
  const id = useId()
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
      queryClient.invalidateQueries({ queryKey: TOKENS_KEY })
      onCreated(result)
    },
  })
  const valid = name.trim() !== '' && scopes.length > 0

  function submit(event: FormEvent) {
    event.preventDefault()
    if (valid) create.mutate()
  }

  function toggle(changed: readonly Scope[], checked: boolean) {
    setScopes((current) =>
      checked ? [...new Set([...current, ...changed])] : current.filter((scope) => !changed.includes(scope)),
    )
  }

  const submitButton = (
    <button type="submit" className="btn btn-primary" disabled={create.isPending || !valid}>
      {create.isPending ? 'Criando…' : 'Criar token'}
    </button>
  )

  return (
    <form className={styles.form} onSubmit={submit}>
      <div className="field">
        <label htmlFor={`${id}-nome`}>Nome</label>
        <input
          id={`${id}-nome`}
          className="input"
          value={name}
          maxLength={100}
          onChange={(event) => setName(event.target.value)}
          placeholder="Ex.: Claude Desktop"
        />
      </div>
      <fieldset className={`field ${styles.fieldset}`}>
        <legend className="field-label">Escopos</legend>
        <div className={styles.groups}>
          {SCOPE_GROUPS.map((group) => (
            <span key={group.id} className={styles.groupRow}>
              <label className="check">
                <input
                  type="checkbox"
                  checked={hasGroup(scopes, group)}
                  onChange={(event) => toggle(group.scopes, event.target.checked)}
                />
                <span className="box" />
                <span>{group.label}</span>
              </label>
              {groupHints?.[group.id]}
            </span>
          ))}
        </div>
        {showIndividual && (
          <details className="disclosure">
            <summary>Escopos individuais</summary>
            <div className={styles.presets}>
              {/* Outside the summary: a button inside it would be a nested interactive control. */}
              <HelpHint subject="os escopos individuais" title="Escopos individuais" article="criar-token">
                Para integrações que pedem um escopo fora dos grupos, como o importador do lumea.
              </HelpHint>
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
                <label key={scope} className="check">
                  <input
                    type="checkbox"
                    checked={scopes.includes(scope)}
                    onChange={(event) => toggle([scope], event.target.checked)}
                  />
                  <span className="box" />
                  <span>
                    {label} <span className={styles.scopeCode}>{scope}</span>
                    <span className={`field-hint ${styles.scopeDescription}`}>{description}</span>
                  </span>
                </label>
              ))}
            </div>
          </details>
        )}
      </fieldset>
      <fieldset className={`field ${styles.fieldset}`}>
        <legend className="field-label">Validade</legend>
        <div className="seg">
          {EXPIRATIONS.map((option) => (
            <label key={option.value} className="seg-opt">
              <input
                type="radio"
                name={`${id}-validade`}
                value={option.value}
                checked={expiration === option.value}
                onChange={() => setExpiration(option.value)}
              />
              {option.label}
            </label>
          ))}
        </div>
      </fieldset>
      {create.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(create.error)}
        </p>
      )}
      {onCancel ? (
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            Cancelar
          </button>
          {submitButton}
        </div>
      ) : (
        submitButton
      )}
    </form>
  )
}
