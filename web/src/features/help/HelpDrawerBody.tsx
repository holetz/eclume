import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { isSearchShortcut } from '../../app/help'
import { articlesForPage, useHelpCatalog } from './catalog'
import { HelpSearch } from './HelpSearch'
import type { HelpPageKey } from './pages'
import { searchArticles } from './search'

const MAX_RESULTS = 6

/** The help drawer body: search, the page's articles ("On this page") and the shortcuts. */
export default function HelpDrawerBody({ pageKey }: { pageKey: HelpPageKey | null }) {
  const { t } = useTranslation('shell')
  const catalog = useHelpCatalog()
  const [query, setQuery] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const results = useMemo(() => searchArticles(query, catalog.articles, MAX_RESULTS), [query, catalog])
  const pageArticles = pageKey ? articlesForPage(catalog, pageKey) : []

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
      <HelpSearch value={query} onChange={setQuery} inputRef={input} placeholder={t('helpCenter.search')} />
      <div className="help-drawer-body">
        {query.trim() ? (
          <div className="help-section">
            <span className="kicker">{t('helpCenter.resultsKicker')}</span>
            {results.length > 0 ? (
              <ul className="help-links" aria-label={t('helpCenter.resultsInHelp')}>
                {results.map(({ article }) => (
                  <li key={article.slug}>
                    <Link to={`/ajuda/${article.slug}`}>{article.title}</Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted" role="status">
                {t('helpCenter.nothingFoundShort')}
              </p>
            )}
          </div>
        ) : (
          pageKey &&
          pageArticles.length > 0 && (
            <div className="help-section">
              <span className="kicker">{t('helpCenter.onThisPageIn', { page: t(`helpCenter.pages.${pageKey}`) })}</span>
              <ul className="help-links" aria-label={t('helpCenter.articlesAbout', { page: t(`helpCenter.pages.${pageKey}`) })}>
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
          <span className="kicker">{t('helpCenter.shortcuts')}</span>
          <dl className="shortcuts">
            <div>
              <dt>{t('helpCenter.openHelp')}</dt>
              <dd>
                <kbd className="kbd">?</kbd>
              </dd>
            </div>
            <div>
              <dt>{t('helpCenter.searchHelp')}</dt>
              <dd>
                <kbd className="kbd">/</kbd>
              </dd>
            </div>
            <div>
              <dt>{t('helpCenter.closeHelp')}</dt>
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
