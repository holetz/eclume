import { useTranslation } from 'react-i18next'
import type { ReactNode } from 'react'
import { Dialog } from './Dialog'

interface ConfirmDialogProps {
  title: string
  children?: ReactNode
  /** The label of the destructive action (`btn btn-danger`). */
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
  busy?: boolean
}

/**
 * Asks for confirmation before a destructive action, in the DS `Dialog`. Cancel comes first and takes
 * focus; Esc and a click on the backdrop also cancel. With `busy`, the mutation runs and the confirmation waits.
 */
export function ConfirmDialog({ title, children, confirmLabel, onConfirm, onCancel, busy = false }: ConfirmDialogProps) {
  const { t } = useTranslation()
  return (
    <Dialog
      title={title}
      onClose={onCancel}
      message={children}
      actions={
        <>
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            {t('cancel')}
          </button>
          <button type="button" className="btn btn-danger" onClick={onConfirm} disabled={busy} aria-busy={busy}>
            {confirmLabel}
          </button>
        </>
      }
    />
  )
}
