import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { isSearchShortcut } from '../../app/help'
import { ARTICLES, articlesForPage } from './catalog'
import { HelpSearch } from './HelpSearch'
import { HELP_PAGES, type HelpPageKey } from './pages'
import { searchArticles } from './search'

const MAX_RESULTS = 6

/** The help drawer body: search, the page's articles ("Nesta página") and the shortcuts. */
export default function HelpDrawerBody({ pageKey }: { pageKey: HelpPageKey | null }) {
  const { t } = useTranslation('help')
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
      <HelpSearch value={query} onChange={setQuery} inputRef={input} placeholder={t('search.label')} />
      <div className="help-drawer-body">
        {query.trim() ? (
          <div className="help-section">
            <span className="kicker">{t('drawer.results')}</span>
            {results.length > 0 ? (
              <ul className="help-links" aria-label={t('drawer.resultsLabel')}>
                {results.map(({ article }) => (
                  <li key={article.slug}>
                    <Link to={`/ajuda/${article.slug}`}>{article.title}</Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted" role="status">
                {t('drawer.none')}
              </p>
            )}
          </div>
        ) : (
          pageKey &&
          pageArticles.length > 0 && (
            <div className="help-section">
              <span className="kicker">{t('drawer.onThisPage', { page: HELP_PAGES[pageKey] })}</span>
              <ul className="help-links" aria-label={t('drawer.articlesAbout', { page: HELP_PAGES[pageKey] })}>
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
          <span className="kicker">{t('drawer.shortcuts')}</span>
          <dl className="shortcuts">
            <div>
              <dt>{t('drawer.open')}</dt>
              <dd>
                <kbd className="kbd">?</kbd>
              </dd>
            </div>
            <div>
              <dt>{t('drawer.search')}</dt>
              <dd>
                <kbd className="kbd">/</kbd>
              </dd>
            </div>
            <div>
              <dt>{t('drawer.close')}</dt>
              <dd>
                <kbd className="kbd">{t('drawer.esc')}</kbd>
              </dd>
            </div>
          </dl>
        </div>
      </div>
    </>
  )
}
