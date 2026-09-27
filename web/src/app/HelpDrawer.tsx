import { X } from 'lucide-react'
import { useEffect, useId, useRef } from 'react'
import { Link } from 'react-router'
import type { HelpTopic } from './help'
import { NAV_ITEMS } from './nav'

const HELP_CENTER = NAV_ITEMS.find((item) => item.to === '/ajuda')

/** O `.help-drawer` do Design System: links da página, atalhos e o caminho para a central de ajuda. */
export function HelpDrawer({ topic, onClose }: { topic: HelpTopic | null; onClose: () => void }) {
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
      <div className="help-drawer-body">
        {topic && (
          <div className="help-section">
            <span className="kicker">Nesta página · {topic.title}</span>
            <ul className="help-links">
              {topic.links.map((link) => (
                <li key={link.to}>
                  <Link to={link.to} onClick={onClose}>
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="help-section">
          <span className="kicker">Atalhos</span>
          <dl className="shortcuts">
            <div>
              <dt>Abrir a ajuda</dt>
              <dd>
                <kbd className="kbd">?</kbd>
              </dd>
            </div>
            <div>
              <dt>Fechar a ajuda</dt>
              <dd>
                <kbd className="kbd">Esc</kbd>
              </dd>
            </div>
          </dl>
        </div>
      </div>
      <div className="help-drawer-foot">
        {HELP_CENTER?.enabled && (
          <Link to={HELP_CENTER.to} onClick={onClose}>
            Abrir a central de ajuda
          </Link>
        )}
        <span className="text-muted">
          Pressione <kbd className="kbd">?</kbd> a qualquer momento
        </span>
      </div>
    </aside>
  )
}
