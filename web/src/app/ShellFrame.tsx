import { Menu, X } from 'lucide-react'
import { useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { useLocation } from 'react-router'
import { NavigatedPathContext } from './pageFocus'
import styles from './ShellFrame.module.css'

interface ShellFrameProps {
  /** The brand: in the header, or at the top of the sidebar when there is no header. */
  brand: ReactNode
  /** The rest of the sidebar: navigation and footer. */
  sidebar: ReactNode
  /**
   * The account, on the right of a narrow header at any width (the user app). Without it
   * (the admin panel), the brand stays in the sidebar and the header only shows on a narrow screen.
   */
  account?: ReactNode
  children: ReactNode
}

/**
 * The Design System's `.shell` frame, shared by the app and the admin panel: fixed sidebar and, below
 * 56rem, the Menu button in the header, which opens the sidebar on top. The fixed header's height
 * lives in `--shell-header`, for the screens that stick elements to the top.
 */
export function ShellFrame({ brand, sidebar, account, children }: ShellFrameProps) {
  const { pathname } = useLocation()
  // From the first route change on, the new page's `PageHead` moves focus to the title.
  const [firstPath] = useState(pathname)
  const [navigated, setNavigated] = useState(false)
  if (!navigated && pathname !== firstPath) setNavigated(true)
  // The compact menu holds for the route it was opened on: navigating closes it.
  const [menuOpenAt, setMenuOpenAt] = useState<string | null>(null)
  const menuOpen = menuOpenAt === pathname
  const navId = useId()
  const menuButton = useRef<HTMLButtonElement>(null)
  const sidebarRef = useRef<HTMLElement>(null)

  // Open, the compact menu moves focus to the first link; Esc closes it and returns focus to the Menu button.
  useEffect(() => {
    if (!menuOpen) return
    sidebarRef.current?.querySelector<HTMLElement>('a[href]')?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setMenuOpenAt(null)
      menuButton.current?.focus()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [menuOpen])

  // The link of the route you are already on does not navigate: it closes the menu, as the others would.
  function closeOnCurrentLink(event: MouseEvent<HTMLElement>) {
    const link = (event.target as HTMLElement).closest('a[href]') as HTMLAnchorElement | null
    if (menuOpen && link && new URL(link.href).pathname === pathname) setMenuOpenAt(null)
  }

  return (
    <NavigatedPathContext.Provider value={navigated ? pathname : null}>
      <div className={`shell ${styles.shell}`} data-header={account ? '' : undefined}>
        <a className="skip-link" href="#conteudo">
          Pular para o conteúdo
        </a>
        <header className={styles.topbar}>
          {brand}
          {account && <div className={styles.account}>{account}</div>}
          <button
            ref={menuButton}
            type="button"
            className={`btn btn-secondary ${styles.menuButton}`}
            aria-expanded={menuOpen}
            aria-controls={navId}
            onClick={() => setMenuOpenAt(menuOpen ? null : pathname)}
          >
            {menuOpen ? <X size={16} aria-hidden /> : <Menu size={16} aria-hidden />}
            Menu
          </button>
        </header>
        <aside
          ref={sidebarRef}
          className={`sidebar ${styles.sidebar}`}
          id={navId}
          data-open={menuOpen}
          onClick={closeOnCurrentLink}
        >
          {!account && <div className={styles.brandSide}>{brand}</div>}
          {sidebar}
        </aside>
        <main id="conteudo" tabIndex={-1} className={`main ${styles.main}`}>
          {children}
        </main>
      </div>
    </NavigatedPathContext.Provider>
  )
}
