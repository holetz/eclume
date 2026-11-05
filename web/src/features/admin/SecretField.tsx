import { useId, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { errorMessage } from '../../api/problem'
import { ConfirmDialog } from '../../app/ConfirmDialog'
import styles from './Admin.module.css'
import { formatShortDay } from './labels'

interface SecretFieldProps {
  label: string
  isSet: boolean
  updatedAt: string | null
  hint?: ReactNode
  onSave: (value: string) => Promise<unknown>
  onClear: () => Promise<unknown>
}

/**
 * Write-only secret: stored, it shows only that it exists (the API never returns any part of it)
 * and is replaced or deleted; empty, it asks for the value. Saves at once, apart from Salvar.
 */
export function SecretField({ label, isSet, updatedAt, hint, onSave, onClear }: SecretFieldProps) {
  const { t } = useTranslation('admin')
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [confirming, setConfirming] = useState(false)
  const labelId = useId()
  const inputId = useId()
  const hintId = useId()
  const asking = !isSet || editing

  async function run(action: () => Promise<unknown>, done: () => void) {
    setPending(true)
    setError(null)
    try {
      await action()
      done()
    } catch (caught) {
      setError(caught)
    } finally {
      setPending(false)
    }
  }

  function save() {
    const trimmed = value.trim()
    if (!trimmed) return
    void run(
      () => onSave(trimmed),
      () => {
        setValue('')
        setEditing(false)
      },
    )
  }

  function cancel() {
    setValue('')
    setEditing(false)
    setError(null)
  }

  return (
    <div className="field" role="group" aria-labelledby={labelId}>
      {asking ? (
        <label id={labelId} htmlFor={inputId}>
          {label}
        </label>
      ) : (
        <span id={labelId} className={styles.label}>
          {label}
        </span>
      )}
      {asking ? (
        <div className={styles.secretRow}>
          <input
            id={inputId}
            className="input"
            type="password"
            autoComplete="off"
            value={value}
            aria-describedby={hint || isSet ? hintId : undefined}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              // The field may sit inside the page's form: Enter saves the secret, not the form.
              if (e.key === 'Enter') {
                e.preventDefault()
                save()
              }
            }}
          />
          <button type="button" className="btn btn-primary btn-sm" disabled={pending || !value.trim()} onClick={save}>
            {pending ? t('secret.saving') : t('secret.save')}
          </button>
          {isSet && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={cancel}>
              {t('secret.cancel')}
            </button>
          )}
        </div>
      ) : (
        <div className="code-block">
          <span>{t('secret.stored')}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}>
            {t('secret.replace')}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirming(true)}>
            {t('secret.delete')}
          </button>
        </div>
      )}
      {(hint || isSet) && (
        <span id={hintId} className="field-hint">
          {isSet && (updatedAt ? t('secret.writeOnlyUpdated', { date: formatShortDay(updatedAt) }) : t('secret.writeOnly'))}
          {hint}
        </span>
      )}
      {error !== null && (
        <p className="alert alert-error" role="alert">
          {errorMessage(error)}
        </p>
      )}
      {confirming && (
        <ConfirmDialog
          title={t('secret.confirmTitle', { label })}
          confirmLabel={t('secret.delete')}
          busy={pending}
          onConfirm={() => void run(onClear, () => setConfirming(false))}
          onCancel={() => setConfirming(false)}
        >
          {t('secret.confirmBody')}
        </ConfirmDialog>
      )}
    </div>
  )
}
