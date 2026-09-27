import { X } from 'lucide-react'
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

interface DialogProps {
  title: string
  /** Pedido de fechamento (Esc, clique no fundo, botão Fechar); quem monta decide se desmonta. */
  onClose: () => void
  children?: ReactNode
  /** Os botões do rodapé (`.dialog-actions`). */
  actions?: ReactNode
  size?: 'lg'
  /** Kicker sobre o título; com ele, o cabeçalho ganha o botão Fechar (`.dialog-head`). */
  kicker?: string
  /** Conteúdo rico (tabela, zona de soltar) fora do `.dialog-body`, que atenua o texto. */
  plain?: boolean
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

// Diálogos abertos, o de cima por último: só ele responde ao Esc.
const openDialogs: HTMLElement[] = []

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)]
}

/**
 * O `.dialog` do Design System sobre o `.dialog-backdrop`, num portal no `body`. Ao abrir, leva o
 * foco ao primeiro controle do corpo (ou ao Fechar); prende o Tab, fecha com Esc e com clique no
 * fundo, trava a rolagem da página e, ao desmontar, devolve o foco a quem abriu.
 */
export function Dialog({ title, onClose, children, actions, size, kicker, plain = false }: DialogProps) {
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
    // O Esc vale mesmo com o foco fora (um botão que ficou desabilitado o perde para o body).
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
    // Só na montagem: o diálogo é montado aberto e desmontado ao fechar.
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
