import { useEffect, useMemo, useRef } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Link, useSearchParams } from 'react-router'
import { isSearchShortcut, useHelpTopic } from '../../app/help'
import { PageHead } from '../../app/PageHead'
import { ArticleBody } from './ArticleBody'
import { articlesByTopic, TOPIC_KEYS, useHelpCatalog, type HelpCatalog, type TopicKey } from './catalog'
import styles from './Help.module.css'
import { HelpSearch, Snippet } from './HelpSearch'
import { searchArticles } from './search'

const PREVIEW = 3

export function HelpCenterPage() {
  useHelpTopic('ajuda')
  const { t } = useTranslation('help')
  const catalog = useHelpCatalog()
  const [params, setParams] = useSearchParams()
  const q = params.get('q') ?? ''
  const topicKey = TOPIC_KEYS.find((key) => key === params.get('topico'))
  const searchInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!isSearchShortcut(event)) return
      event.preventDefault()
      searchInput.current?.focus()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <section className={styles.page}>
      <PageHead kicker={t('kicker')} title={t('center')} />
      <HelpSearch
        className={styles.search}
        inputRef={searchInput}
        value={q}
        shortcut
        onChange={(value) => setParams(value ? { q: value } : {}, { replace: true })}
      />
      {q.trim() ? (
        <SearchResults query={q} catalog={catalog} />
      ) : topicKey ? (
        <TopicList topic={topicKey} catalog={catalog} />
      ) : (
        <>
          <TopicGrid catalog={catalog} />
          <Questions catalog={catalog} />
        </>
      )}
      <p className={`text-muted ${styles.footer}`}>{t('footer')}</p>
    </section>
  )
}

function SearchResults({ query, catalog }: { query: string; catalog: HelpCatalog }) {
  const { t } = useTranslation('help')
  const hits = useMemo(() => searchArticles(query, catalog.articles), [query, catalog])
  if (hits.length === 0) {
    return (
      <p className={styles.empty} role="status">
        <Trans t={t} i18nKey="noResults" values={{ query: query.trim() }} components={{ topics: <Link to="/ajuda" /> }} />
      </p>
    )
  }
  return (
    <>
      <p className="visually-hidden" role="status">
        {t('found', { count: hits.length })}
      </p>
      <ul className={`list ${styles.plainList}`} aria-label={t('results')}>
        {hits.map(({ article, snippet }) => (
          <li key={article.slug} className="list-row">
            <Link className={`list-row-title ${styles.rowLink}`} to={`/ajuda/${article.slug}`}>
              {article.title}
            </Link>
            <span className="list-row-sub">
              <span className={styles.resultTopic}>{t(`topic.${article.topic}.title`)}</span>
              {snippet && (
                <>
                  {' · '}
                  <Snippet snippet={snippet} />
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
    </>
  )
}

function TopicGrid({ catalog }: { catalog: HelpCatalog }) {
  const { t } = useTranslation('help')
  return (
    <div className="topic-grid">
      {TOPIC_KEYS.map((key) => {
        const articles = articlesByTopic(catalog, key)
        return (
          <section key={key} className="topic" aria-labelledby={`topico-${key}`}>
            <span className="kicker">{t(`topic.${key}.kicker`)}</span>
            <h2 className="topic-title" id={`topico-${key}`}>
              {t(`topic.${key}.title`)}
            </h2>
            <ul>
              {articles.slice(0, PREVIEW).map((article) => (
                <li key={article.slug}>
                  <Link to={`/ajuda/${article.slug}`}>{article.title}</Link>
                </li>
              ))}
            </ul>
            <TopicMore topic={key} count={articles.length} />
          </section>
        )
      })}
    </div>
  )
}

function TopicMore({ topic, count }: { topic: TopicKey; count: number }) {
  const { t } = useTranslation('help')
  return (
    <Link className="topic-more" to={`/ajuda?topico=${topic}`}>
      {t('allArticles', { n: count })}
    </Link>
  )
}

function TopicList({ topic, catalog }: { topic: TopicKey; catalog: HelpCatalog }) {
  const { t } = useTranslation('help')
  return (
    <div className={styles.topicList}>
      <Link to="/ajuda" className={styles.back}>
        {t('allTopics')}
      </Link>
      <span className="kicker">{t(`topic.${topic}.kicker`)}</span>
      <h2 className={styles.sectionTitle}>{t(`topic.${topic}.title`)}</h2>
      <ul className={`list ${styles.plainList}`} aria-label={t(`topic.${topic}.title`)}>
        {articlesByTopic(catalog, topic).map((article) => (
          <li key={article.slug} className="list-row">
            <Link className={`list-row-title ${styles.rowLink}`} to={`/ajuda/${article.slug}`}>
              {article.title}
            </Link>
            <span className="list-row-sub">{t('minutes', { n: article.minutes })}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Questions({ catalog }: { catalog: HelpCatalog }) {
  const { t } = useTranslation('help')
  return (
    <section aria-labelledby="perguntas-frequentes" className={styles.questions}>
      <h2 id="perguntas-frequentes" className={styles.sectionTitle}>
        {t('questions')}
      </h2>
      <div className="faq">
        {catalog.questions.map((item, index) => (
          <details key={item.question} className="disclosure" open={index === 0}>
            <summary>{item.question}</summary>
            <div className="faq-answer">
              <ArticleBody markdown={item.answer} bare />
            </div>
          </details>
        ))}
      </div>
    </section>
  )
}
