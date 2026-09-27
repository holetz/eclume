import type { ReactNode } from 'react'
import { Dialog } from './Dialog'

interface ConfirmDialogProps {
  title: string
  children?: ReactNode
  /** O rótulo da ação destrutiva (`btn btn-danger`). */
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
  busy?: boolean
}

/**
 * Pede confirmação antes de uma ação destrutiva, no `Dialog` do DS. "Cancelar" vem primeiro e recebe
 * o foco; o Esc e o clique no fundo também cancelam. Com `busy`, a mutação corre e a confirmação espera.
 */
export function ConfirmDialog({ title, children, confirmLabel, onConfirm, onCancel, busy = false }: ConfirmDialogProps) {
  return (
    <Dialog
      title={title}
      onClose={onCancel}
      actions={
        <>
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            Cancelar
          </button>
          <button type="button" className="btn btn-danger" onClick={onConfirm} disabled={busy} aria-busy={busy}>
            {confirmLabel}
          </button>
        </>
      }
    >
      {children}
    </Dialog>
  )
}
