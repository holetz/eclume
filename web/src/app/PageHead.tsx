import type { ReactNode } from 'react'
import { usePageTitle } from './usePageTitle'

interface PageHeadProps {
  title: string
  kicker?: string
  /** Ações da página, à direita do título (botões, links). */
  actions?: ReactNode
}

/** O `.page-head` do Design System: kicker opcional, `h1` e ações; também dá o título da aba. */
export function PageHead({ title, kicker, actions }: PageHeadProps) {
  usePageTitle(title)
  return (
    <div className="page-head">
      <div>
        {kicker && <span className="kicker">{kicker}</span>}
        <h1>{title}</h1>
      </div>
      {actions && <div className="page-head-actions">{actions}</div>}
    </div>
  )
}
