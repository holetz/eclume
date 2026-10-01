import { useEffect, useRef, type ReactNode } from 'react'
import { useHelp } from './help'
import { useNavigatedPath } from './pageFocus'
import { usePageTitle } from './usePageTitle'

interface PageHeadProps {
  title: string
  kicker?: string
  /** Ações da página, à direita do título (botões, links). */
  actions?: ReactNode
  /** Uma dica em linha (`HelpHint`) ao lado do título, fora do nome do `h1`. */
  hint?: ReactNode
}

/**
 * O `.page-head` do Design System: kicker opcional, `h1`, ações e, dentro do shell, o botão Ajuda.
 * Depois de uma troca de rota (não na primeira carga nem numa troca só de busca), o foco vai para o
 * `h1`, para o leitor de tela anunciar a página nova e o teclado recomeçar do topo dela.
 */
export function PageHead({ title, kicker, actions, hint }: PageHeadProps) {
  usePageTitle(title)
  const help = useHelp()
  const navigatedPath = useNavigatedPath()
  const titleRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    // Sem rolar: a âncora da página (o `?t=` da gravação) decide a rolagem.
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
