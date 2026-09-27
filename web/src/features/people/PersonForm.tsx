import { useId, useState, type FormEvent, type ReactNode } from 'react'
import { errorMessage } from '../../api/problem'
import styles from './People.module.css'

export interface PersonFields {
  name: string
  email: string | null
  notes: string | null
}

interface PersonFormProps {
  initial: PersonFields
  pending: boolean
  error: unknown
  onSubmit: (fields: PersonFields) => void
  onCancel: () => void
  /** Ação destrutiva à esquerda do rodapé (Excluir pessoa). */
  danger?: ReactNode
}

/** Edição de nome, e-mail e notas de uma pessoa, no diálogo "Editar"; campos vazios viram `null`. */
export function PersonForm({ initial, pending, error, onSubmit, onCancel, danger }: PersonFormProps) {
  const [name, setName] = useState(initial.name)
  const [email, setEmail] = useState(initial.email ?? '')
  const [notes, setNotes] = useState(initial.notes ?? '')
  const id = useId()

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!name.trim()) return
    onSubmit({ name: name.trim(), email: email.trim() || null, notes: notes.trim() || null })
  }

  return (
    <form className={styles.form} onSubmit={submit}>
      <div className="field">
        <label htmlFor={`${id}-nome`}>Nome</label>
        <input id={`${id}-nome`} className="input" value={name} onChange={(e) => setName(e.target.value)} required />
      </div>
      <div className="field">
        <label htmlFor={`${id}-email`}>E-mail</label>
        <input
          id={`${id}-email`}
          className="input"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="off"
        />
      </div>
      <div className="field">
        <label htmlFor={`${id}-notas`}>Notas</label>
        <textarea id={`${id}-notas`} className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      {error != null && (
        <p className="alert alert-error" role="alert">
          {errorMessage(error)}
        </p>
      )}
      <div className="dialog-actions">
        {danger}
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          Cancelar
        </button>
        <button type="submit" className="btn btn-primary" disabled={pending || !name.trim()}>
          Salvar
        </button>
      </div>
    </form>
  )
}
