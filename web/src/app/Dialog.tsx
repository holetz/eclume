import { X } from 'lucide-react'
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { openDialogs } from './dialogStack'

interface DialogProps {
  title: string
  /** Close request (Esc, backdrop click, Close button); whoever mounts it decides whether to unmount. */
  onClose: () => void
  /** The dialog text (a confirmation), in `.dialog-body`. */
  message?: ReactNode
  /** The content, in `.dialog-body` or, with `plain`, after the message and without its muted style. */
  children?: ReactNode
  /** The footer buttons (`.dialog-actions`). */
  actions?: ReactNode
  size?: 'lg'
  /** Kicker above the title; with it, the header gets the Close button (`.dialog-head`). */
  kicker?: string
  /** Rich content (form, table, drop zone) outside `.dialog-body`, which mutes the text. */
  plain?: boolean
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)]
}

/**
 * The Design System `.dialog` over `.dialog-backdrop`, in a portal on `body`. On opening, it moves
 * focus to the first control of the body (or to Close); it traps Tab, closes on Esc and on a backdrop
 * click, locks page scrolling and, on unmount, returns focus to whoever opened it.
 */
export function Dialog({ title, onClose, message, children, actions, size, kicker, plain = false }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  })

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const body = bodyRef.current
    const first = (body && focusables(body)[0]) ?? closeRef.current ?? focusables(dialog)[0] ?? dialog
    first.focus()
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    openDialogs.push(dialog)
    // Esc works even with focus outside (a button that became disabled loses it to the body).
    function onEscape(event: globalThis.KeyboardEvent) {
      if (event.key !== 'Escape' || openDialogs[openDialogs.length - 1] !== dialog) return
      event.preventDefault()
      onCloseRef.current()
    }
    document.addEventListener('keydown', onEscape)
    return () => {
      document.removeEventListener('keydown', onEscape)
      openDialogs.splice(openDialogs.indexOf(dialog), 1)
      document.body.style.overflow = overflow
      if (opener?.isConnected) opener.focus()
    }
    // Mount only: the dialog is mounted open and unmounted on close.
  }, [])

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Tab' || !ref.current) return
    const items = focusables(ref.current)
    if (items.length === 0) {
      event.preventDefault()
      return
    }
    const first = items[0]
    const last = items[items.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return createPortal(
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={ref}
        className={size === 'lg' ? 'dialog dialog-lg' : 'dialog'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        {kicker ? (
          <div className="dialog-head">
            <div>
              <span className="kicker">{kicker}</span>
              <span className="dialog-title" id={titleId}>
                {title}
              </span>
            </div>
            <button
              ref={closeRef}
              type="button"
              className="btn btn-ghost btn-icon"
              aria-label="Fechar"
              onClick={() => onClose()}
            >
              <X size={16} aria-hidden />
            </button>
          </div>
        ) : (
          <div className="dialog-title" id={titleId}>
            {title}
          </div>
        )}
        {message && <div className="dialog-body">{message}</div>}
        {children && (
          <div ref={bodyRef} className={plain ? undefined : 'dialog-body'}>
            {children}
          </div>
        )}
        {actions && <div className="dialog-actions">{actions}</div>}
      </div>
    </div>,
    document.body,
  )
}
