import { useEffect, useId, useRef, type ReactNode } from 'react'

interface DialogProps {
  title: string
  onClose: () => void
  children?: ReactNode
  /** Os botões do rodapé (`.dialog-actions`). */
  actions?: ReactNode
  size?: 'lg'
}

/**
 * O `.dialog` do Design System num `<dialog>` nativo aberto com `showModal()`: o navegador prende o
 * foco e trata o Esc. Monte-o só enquanto estiver aberto; ao desmontar, o foco volta a quem abriu.
 */
export function Dialog({ title, onClose, children, actions, size }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (!dialog.open) dialog.showModal()
    return () => {
      if (dialog.open) dialog.close()
      opener?.focus()
    }
  }, [])

  return (
    <dialog
      ref={ref}
      className={size === 'lg' ? 'dialog dialog-lg' : 'dialog'}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <div className="dialog-title" id={titleId}>
        {title}
      </div>
      {children && <div className="dialog-body">{children}</div>}
      {actions && <div className="dialog-actions">{actions}</div>}
    </dialog>
  )
}
