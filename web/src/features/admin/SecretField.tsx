import { useId, useState, type ReactNode } from 'react'
import { errorMessage } from '../../api/problem'
import { ConfirmDialog } from '../../app/ConfirmDialog'
import styles from './Admin.module.css'

interface SecretFieldProps {
  label: string
  isSet: boolean
  updatedAt: string | null
  hint?: ReactNode
  onSave: (value: string) => Promise<unknown>
  onClear: () => Promise<unknown>
}

const updated = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short' })

/**
 * Segredo só de escrita: guardado, mostra só que existe (a API nunca devolve parte dele) e se
 * substitui ou apaga; vazio, pede o valor. Grava na hora, fora do Salvar da página.
 */
export function SecretField({ label, isSet, updatedAt, hint, onSave, onClear }: SecretFieldProps) {
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
              // O campo pode estar dentro do form da página: Enter grava o segredo, não o form.
              if (e.key === 'Enter') {
                e.preventDefault()
                save()
              }
            }}
          />
          <button type="button" className="btn btn-primary btn-sm" disabled={pending || !value.trim()} onClick={save}>
            {pending ? 'Salvando…' : 'Salvar'}
          </button>
          {isSet && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={cancel}>
              Cancelar
            </button>
          )}
        </div>
      ) : (
        <div className="code-block">
          <span>•••••••• guardado</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}>
            Substituir
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirming(true)}>
            Apagar
          </button>
        </div>
      )}
      {(hint || isSet) && (
        <span id={hintId} className="field-hint">
          {isSet && `Só escrita${updatedAt ? ` · atualizado em ${updated.format(new Date(updatedAt))}` : ''}. `}
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
          title={`Apagar ${label}?`}
          confirmLabel="Apagar"
          busy={pending}
          onConfirm={() => void run(onClear, () => setConfirming(false))}
          onCancel={() => setConfirming(false)}
        >
          O valor guardado some do servidor e não volta.
        </ConfirmDialog>
      )}
    </div>
  )
}
