import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import styles from './SearchPage.module.css'

interface FilterChipProps {
  label: string
  /** The value in words ("qualquer", "Ana Ribeiro", "Últimos 30 dias"). */
  value: string
  active: boolean
  /** The filter control; `close` closes the popover after applying. */
  children: (close: () => void) => ReactNode
}

/**
 * The search filter chip: `tag tag-neutral` (or `tag-accent` when active) with "Rótulo: valor",
 * which opens a popover in the `.menu` style with the control and Aplicar. Esc and a click outside close it.
 */
export function FilterChip({ label, value, active, children }: FilterChipProps) {
  const { t } = useTranslation('search')
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const popoverId = useId()
  // Closing through Aplicar or Esc returns focus to the chip; a click outside leaves the focus where it went.
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
        {t('chip.label', { label, value })}
      </button>
      {open && (
        <div id={popoverId} className={`menu ${styles.popover}`} role="dialog" aria-label={t('chip.filter', { label })}>
          {children(close)}
        </div>
      )}
    </div>
  )
}
