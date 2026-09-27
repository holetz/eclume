import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import styles from './SearchPage.module.css'

interface FilterChipProps {
  label: string
  /** O valor em palavras ("qualquer", "Ana Ribeiro", "Últimos 30 dias"). */
  value: string
  active: boolean
  /** O controle do filtro; `close` fecha o popover depois de aplicar. */
  children: (close: () => void) => ReactNode
}

/**
 * A ficha de filtro da busca: `tag tag-neutral` (ou `tag-accent` quando ativa) com "Rótulo: valor",
 * que abre um popover no estilo do `.menu` com o controle e Aplicar. Esc e o clique fora fecham.
 */
export function FilterChip({ label, value, active, children }: FilterChipProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const popoverId = useId()
  // Fechar pelo Aplicar ou pelo Esc devolve o foco à ficha; o clique fora deixa o foco onde foi.
  const wasOpen = useRef(false)
  const clickedOutside = useRef(false)

  useEffect(() => {
    if (wasOpen.current && !open && !clickedOutside.current) buttonRef.current?.focus()
    wasOpen.current = open
    clickedOutside.current = false
  }, [open])

  useEffect(() => {
    if (!open) return
    function onPointerDown(event: PointerEvent) {
      if (rootRef.current?.contains(event.target as Node)) return
      clickedOutside.current = true
      setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  const close = () => setOpen(false)

  return (
    <div
      className={styles.chip}
      ref={rootRef}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation()
          close()
        }
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className={`tag ${active ? 'tag-accent' : 'tag-neutral'} ${styles.chipButton}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        onClick={() => setOpen(!open)}
      >
        {label}: {value}
      </button>
      {open && (
        <div id={popoverId} className={`menu ${styles.popover}`} role="dialog" aria-label={`Filtro ${label}`}>
          {children(close)}
        </div>
      )}
    </div>
  )
}
