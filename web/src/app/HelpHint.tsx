import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router'

interface HelpHintProps {
  /** O assunto, em minúsculas: vira o rótulo "Sobre <assunto>" e o título do popover. */
  subject: string
  title: string
  /** Slug do artigo da central de ajuda que explica o assunto. */
  article: string
  children: ReactNode
}

/** A dica em linha do Design System: o `.hint` "?" que abre um `.popover` com o link para o artigo. */
export function HelpHint({ subject, title, article, children }: HelpHintProps) {
  const [open, setOpen] = useState(false)
  const wrapper = useRef<HTMLSpanElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const popoverId = useId()
  const { pathname } = useLocation()
  const [openedAt, setOpenedAt] = useState(pathname)

  if (open && openedAt !== pathname) setOpen(false)

  useEffect(() => {
    if (!open) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setOpen(false)
      button.current?.focus()
    }
    function onPointerDown(event: PointerEvent) {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [open])

  return (
    <span ref={wrapper} className="hint-anchor">
      <button
        ref={button}
        type="button"
        className="hint"
        aria-label={`Sobre ${subject}`}
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        onClick={() => {
          setOpenedAt(pathname)
          setOpen((value) => !value)
        }}
      >
        ?
      </button>
      {open && (
        <span id={popoverId} className="popover" role="dialog" aria-label={title}>
          <span className="popover-title">{title}</span>
          <span>{children}</span>
          <Link to={`/ajuda/${article}`}>Ler o artigo →</Link>
        </span>
      )}
    </span>
  )
}
