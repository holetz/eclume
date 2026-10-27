import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'

export interface MenuAction {
  key: string
  label: ReactNode
  /** Short text on the right (`<kbd>`), such as the export format. */
  kbd?: string
  disabled?: boolean
  onSelect: () => void
}

export type MenuEntry =
  | MenuAction
  | 'separator'
  /** Label of a part of the menu: not focusable, it separates and names the items below it. */
  | { heading: string }

interface MenuButtonProps {
  /** Button content (icon and label). */
  children: ReactNode
  items: MenuEntry[]
  className?: string
  /** Accessible label of the menu; without it, the menu is labelled by the button. */
  label?: string
  /** Button name when the content is only an icon (also becomes the mouse tooltip). */
  buttonLabel?: string
}

/**
 * Button that opens a DS `.menu`, with the keyboard of the ARIA menu pattern: arrows, Home/End, Enter or
 * Space and Esc; a click outside closes it. The focused item carries `data-active`. A `{ heading }` labels
 * the part that starts at it, as a named separator: the keyboard skips over it.
 */
export function MenuButton({ children, items, className = 'btn btn-secondary', label, buttonLabel }: MenuButtonProps) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const buttonId = useId()
  const menuId = useId()
  const actions = items.filter((item): item is MenuAction => item !== 'separator' && !('heading' in item))

  useEffect(() => {
    if (!open) return
    itemRefs.current[active]?.focus()
  }, [open, active])

  useEffect(() => {
    if (!open) return
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  function openAt(index: number) {
    setActive(index)
    setOpen(true)
  }

  function close() {
    setOpen(false)
    buttonRef.current?.focus()
  }

  function select(index: number) {
    const item = actions[index]
    if (!item || item.disabled) return
    setOpen(false)
    buttonRef.current?.focus()
    item.onSelect()
  }

  function onButtonKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      openAt(0)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      openAt(actions.length - 1)
    }
  }

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const last = actions.length - 1
    const moves: Record<string, number> = {
      ArrowDown: active === last ? 0 : active + 1,
      ArrowUp: active === 0 ? last : active - 1,
      Home: 0,
      End: last,
    }
    if (event.key in moves) {
      event.preventDefault()
      setActive(moves[event.key])
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      select(active)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
    } else if (event.key === 'Tab') {
      setOpen(false)
    }
  }

  let index = -1
  return (
    <div className="menu-button" ref={rootRef}>
      <button
        ref={buttonRef}
        id={buttonId}
        type="button"
        className={className}
        aria-label={buttonLabel}
        title={buttonLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? setOpen(false) : openAt(0))}
        onKeyDown={onButtonKeyDown}
      >
        {children}
      </button>
      {open && (
        <div
          className="menu"
          role="menu"
          id={menuId}
          aria-label={label}
          aria-labelledby={label ? undefined : buttonId}
          onKeyDown={onMenuKeyDown}
        >
          {items.map((item, position) => {
            if (item === 'separator') return <div key={`sep-${position}`} className="menu-sep" role="separator" />
            if ('heading' in item)
              return (
                <div key={`heading-${position}`} className="menu-heading" role="separator" aria-label={item.heading}>
                  {item.heading}
                </div>
              )
            const current = ++index
            return (
              <button
                key={item.key}
                ref={(el) => {
                  itemRefs.current[current] = el
                }}
                type="button"
                role="menuitem"
                className="menu-item"
                tabIndex={current === active ? 0 : -1}
                aria-disabled={item.disabled || undefined}
                data-active={current === active ? '' : undefined}
                onMouseEnter={() => setActive(current)}
                onClick={() => select(current)}
              >
                <span>{item.label}</span>
                {item.kbd && <kbd>{item.kbd}</kbd>}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
