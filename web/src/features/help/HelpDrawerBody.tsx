import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { isSearchShortcut } from '../../app/help'
import { ARTICLES, articlesForPage } from './catalog'
import { HelpSearch } from './HelpSearch'
import { HELP_PAGES, type HelpPageKey } from './pages'
import { searchArticles } from './search'

const MAX_RESULTS = 6

/** O corpo da gaveta de ajuda: a busca, os artigos da página ("Nesta página") e os atalhos. */
export default function HelpDrawerBody({ pageKey }: { pageKey: HelpPageKey | null }) {
  const [query, setQuery] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const results = useMemo(() => searchArticles(query, ARTICLES, MAX_RESULTS), [query])
  const pageArticles = pageKey ? articlesForPage(pageKey) : []

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!isSearchShortcut(event)) return
      event.preventDefault()
      input.current?.focus()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <>
      <HelpSearch value={query} onChange={setQuery} inputRef={input} placeholder="Buscar na ajuda" />
      <div className="help-drawer-body">
        {query.trim() ? (
          <div className="help-section">
            <span className="kicker">Resultados</span>
            {results.length > 0 ? (
              <ul className="help-links" aria-label="Resultados da busca na ajuda">
                {results.map(({ article }) => (
                  <li key={article.slug}>
                    <Link to={`/ajuda/${article.slug}`}>{article.title}</Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted" role="status">
                Nada encontrado. Tente outras palavras.
              </p>
            )}
          </div>
        ) : (
          pageKey &&
          pageArticles.length > 0 && (
            <div className="help-section">
              <span className="kicker">Nesta página · {HELP_PAGES[pageKey]}</span>
              <ul className="help-links" aria-label={`Artigos sobre ${HELP_PAGES[pageKey]}`}>
                {pageArticles.map((article) => (
                  <li key={article.slug}>
                    <Link to={`/ajuda/${article.slug}`}>{article.title}</Link>
                  </li>
                ))}
              </ul>
            </div>
          )
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
              <dt>Buscar na ajuda</dt>
              <dd>
                <kbd className="kbd">/</kbd>
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
    </>
  )
}
