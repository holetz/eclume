import type { ReactNode } from 'react'
import { useHelp } from './help'
import { usePageTitle } from './usePageTitle'

interface PageHeadProps {
  title: string
  kicker?: string
  /** Ações da página, à direita do título (botões, links). */
  actions?: ReactNode
  /** Uma dica em linha (`HelpHint`) ao lado do título, fora do nome do `h1`. */
  hint?: ReactNode
}

/** O `.page-head` do Design System: kicker opcional, `h1`, ações e, dentro do shell, o botão Ajuda. */
export function PageHead({ title, kicker, actions, hint }: PageHeadProps) {
  usePageTitle(title)
  const help = useHelp()
  return (
    <div className="page-head">
      <div>
        {kicker && <span className="kicker">{kicker}</span>}
        {hint ? (
          <div className="page-head-title">
            <h1>{title}</h1>
            {hint}
          </div>
        ) : (
          <h1>{title}</h1>
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
