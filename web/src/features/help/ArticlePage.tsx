import { useEffect, useRef, useState, type RefObject } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Link, useParams } from 'react-router'
import { useHelpTopic } from '../../app/help'
import { PageHead } from '../../app/PageHead'
import { usePageTitle } from '../../app/usePageTitle'
import { ArticleBody } from './ArticleBody'
import { getArticle, useHelpCatalog, type Article, type HelpCatalog } from './catalog'
import styles from './Help.module.css'

export function ArticlePage() {
  useHelpTopic('ajuda')
  const { slug = '' } = useParams()
  const catalog = useHelpCatalog()
  const article = getArticle(catalog, slug)
  if (!article) return <ArticleNotFound />
  return <ArticleView key={article.slug} article={article} catalog={catalog} />
}

function ArticleNotFound() {
  const { t } = useTranslation('help')
  return (
    <section className={styles.page}>
      <PageHead kicker={t('kicker')} title={t('article.notFound')} />
      <p>
        <Trans t={t} i18nKey="article.notFoundBody" components={{ center: <Link to="/ajuda" /> }} />
      </p>
    </section>
  )
}

function ArticleView({ article, catalog }: { article: Article; catalog: HelpCatalog }) {
  const { t, i18n } = useTranslation('help')
  usePageTitle(article.title)
  const updatedFormat = new Intl.DateTimeFormat(i18n.language, { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' })
  const body = useRef<HTMLDivElement>(null)
  const current = useCurrentHeading(body, article.headings[0]?.id)
  const related = article.related.map((slug) => getArticle(catalog, slug)).filter((item): item is Article => item !== undefined)

  return (
    <section className={styles.article}>
      <ol className="crumbs">
        <li>
          <Link to="/ajuda">{t('kicker')}</Link>
        </li>
        <li>
          <Link to={`/ajuda?topico=${article.topic}`}>{t(`topic.${article.topic}.title`)}</Link>
        </li>
        <li aria-current="page">{article.title}</li>
      </ol>
      <div className={`page-head ${styles.articleHead}`}>
        <h1>{article.title}</h1>
        <div className="article-meta">
          <span>{t('minutes', { n: article.minutes })}</span>
          <span>{t('article.updated', { date: updatedFormat.format(new Date(`${article.updated}T00:00:00Z`)) })}</span>
        </div>
      </div>
      <div className="help-article">
        <div ref={body} className={styles.articleMain}>
          <ArticleBody markdown={article.body} />
          {related.length > 0 && (
            <nav className={styles.related} aria-labelledby="artigos-relacionados">
              <span className="kicker" id="artigos-relacionados">
                {t('article.related')}
              </span>
              <ul className="help-links">
                {related.map((item) => (
                  <li key={item.slug}>
                    <Link to={`/ajuda/${item.slug}`}>{item.title}</Link>
                  </li>
                ))}
              </ul>
            </nav>
          )}
        </div>
        {article.headings.length > 0 && (
          <nav className="toc" aria-label={t('article.onThisPage')}>
            <span className="toc-title">{t('article.onThisPage')}</span>
            {article.headings.map((heading) => (
              <a key={heading.id} href={`#${heading.id}`} aria-current={heading.id === current ? 'true' : undefined}>
                {heading.text}
              </a>
            ))}
          </nav>
        )}
      </div>
    </section>
  )
}

/** The article's visible section, from the IntersectionObserver; without it (jsdom), the first one applies. */
function useCurrentHeading(container: RefObject<HTMLElement | null>, first: string | undefined) {
  const [current, setCurrent] = useState(first)

  useEffect(() => {
    const root = container.current
    if (!root || typeof IntersectionObserver === 'undefined') return
    const headings = [...root.querySelectorAll<HTMLElement>('h2[id]')]
    const visible = new Set<string>()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id)
          else visible.delete(entry.target.id)
        }
        const top = headings.find((heading) => visible.has(heading.id))
        if (top) setCurrent(top.id)
      },
      { rootMargin: '0px 0px -60% 0px' },
    )
    headings.forEach((heading) => observer.observe(heading))
    return () => observer.disconnect()
  }, [container])

  return current
}
