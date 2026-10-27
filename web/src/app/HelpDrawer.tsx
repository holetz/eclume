import { X } from 'lucide-react'
import { lazy, Suspense, useEffect, useId, useRef } from 'react'
import { Link } from 'react-router'
import type { HelpPageKey } from '../features/help/pages'
import { NAV_ITEMS } from './nav'

// The body (search, "Nesta página" and shortcuts) brings the article catalog: it loads on first open only.
const HelpDrawerBody = lazy(() => import('../features/help/HelpDrawerBody'))

const HELP_CENTER = NAV_ITEMS.find((item) => item.to === '/ajuda')

/**
 * The Design System `.help-drawer`: search, the page's articles, shortcuts and the way to the help
 * center. A link in the drawer navigates and keeps it open, as in the DS.
 */
export function HelpDrawer({ pageKey, onClose }: { pageKey: HelpPageKey | null; onClose: () => void }) {
  const titleId = useId()
  const closeButton = useRef<HTMLButtonElement>(null)

  useEffect(() => closeButton.current?.focus(), [])

  return (
    <aside className="help-drawer" role="dialog" aria-modal="false" aria-labelledby={titleId}>
      <div className="help-drawer-head">
        <h2 id={titleId}>Ajuda</h2>
        <button
          ref={closeButton}
          type="button"
          className="btn btn-ghost btn-icon"
          aria-label="Fechar a ajuda"
          onClick={onClose}
        >
          <X size={16} aria-hidden />
        </button>
      </div>
      <Suspense
        fallback={
          <div className="help-drawer-body">
            <p role="status">Carregando…</p>
          </div>
        }
      >
        <HelpDrawerBody pageKey={pageKey} />
      </Suspense>
      <div className="help-drawer-foot">
        {HELP_CENTER?.enabled && <Link to={HELP_CENTER.to}>Abrir a central de ajuda</Link>}
        <span className="text-muted">
          Pressione <kbd className="kbd">?</kbd> a qualquer momento
        </span>
      </div>
    </aside>
  )
}
