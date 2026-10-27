import { useEffect, useRef, type ReactNode } from 'react'
import { useHelp } from './help'
import { useNavigatedPath } from './pageFocus'
import { usePageTitle } from './usePageTitle'

interface PageHeadProps {
  title: string
  kicker?: string
  /** Page actions, to the right of the title (buttons, links). */
  actions?: ReactNode
  /** An inline hint (`HelpHint`) beside the title, outside the `h1` name. */
  hint?: ReactNode
}

/**
 * The Design System `.page-head`: optional kicker, `h1`, actions and, inside the shell, the Help button.
 * After a route change (not on the first load nor on a search-only change), focus goes to the
 * `h1`, so the screen reader announces the new page and the keyboard starts again from its top.
 */
export function PageHead({ title, kicker, actions, hint }: PageHeadProps) {
  usePageTitle(title)
  const help = useHelp()
  const navigatedPath = useNavigatedPath()
  const titleRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    // No scrolling: the page's anchor (the recording's `?t=`) decides the scroll.
    if (navigatedPath !== null) titleRef.current?.focus({ preventScroll: true })
  }, [navigatedPath])

  const heading = (
    <h1 ref={titleRef} tabIndex={-1}>
      {title}
    </h1>
  )
  return (
    <div className="page-head">
      <div>
        {kicker && <span className="kicker">{kicker}</span>}
        {hint ? (
          <div className="page-head-title">
            {heading}
            {hint}
          </div>
        ) : (
          heading
        )}
      </div>
      {(actions || help) && (
        <div className="page-head-actions">
          {help && (
            <button type="button" className="btn btn-secondary" onClick={(event) => help.openHelp(event.currentTarget)}>
              <span className="hint" aria-hidden="true">
                ?
              </span>
              Ajuda
            </button>
          )}
          {actions}
        </div>
      )}
    </div>
  )
}
