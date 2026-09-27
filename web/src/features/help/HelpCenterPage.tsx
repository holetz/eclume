import { useEffect, useMemo, useRef } from 'react'
import { Link, useSearchParams } from 'react-router'
import { isEditableTarget, useHelpTopic } from '../../app/help'
import { PageHead } from '../../app/PageHead'
import { ArticleBody } from './ArticleBody'
import { ARTICLES, articlesByTopic, getTopic, QUESTIONS, TOPICS, type Topic, type TopicKey } from './catalog'
import styles from './Help.module.css'
import { HelpSearch, Snippet } from './HelpSearch'
import { searchArticles } from './search'

const PREVIEW = 3

export function HelpCenterPage() {
  useHelpTopic('ajuda')
  const [params, setParams] = useSearchParams()
  const q = params.get('q') ?? ''
  const topicKey = TOPICS.find((topic) => topic.key === params.get('topico'))?.key
  const searchInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey || isEditableTarget(event)) return
      event.preventDefault()
      searchInput.current?.focus()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <section className={styles.page}>
      <PageHead kicker="Ajuda" title="Central de ajuda" />
      <HelpSearch
        className={styles.search}
        inputRef={searchInput}
        value={q}
        shortcut
        onChange={(value) => setParams(value ? { q: value } : {}, { replace: true })}
      />
      {q.trim() ? (
        <SearchResults query={q} />
      ) : topicKey ? (
        <TopicList topic={getTopic(topicKey)} />
      ) : (
        <>
          <TopicGrid />
          <Questions />
        </>
      )}
      <p className={`text-muted ${styles.footer}`}>Ainda com dúvida? Fale com quem administra este servidor.</p>
    </section>
  )
}

function SearchResults({ query }: { query: string }) {
  const hits = useMemo(() => searchArticles(query, ARTICLES), [query])
  if (hits.length === 0) {
    return (
      <p className={styles.empty} role="status">
        Nada encontrado para “{query.trim()}”. Tente outras palavras ou veja os <Link to="/ajuda">tópicos</Link>.
      </p>
    )
  }
  return (
    <>
      <p className="visually-hidden" role="status">
        {hits.length === 1 ? '1 artigo encontrado' : `${hits.length} artigos encontrados`}
      </p>
      <ul className={`list ${styles.plainList}`} aria-label="Resultados da busca">
        {hits.map(({ article, snippet }) => (
          <li key={article.slug} className="list-row">
            <Link className={`list-row-title ${styles.rowLink}`} to={`/ajuda/${article.slug}`}>
              {article.title}
            </Link>
            <span className="list-row-sub">
              <span className={styles.resultTopic}>{getTopic(article.topic).title}</span>
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

function TopicGrid() {
  return (
    <div className="topic-grid">
      {TOPICS.map((topic) => {
        const articles = articlesByTopic(topic.key)
        return (
          <section key={topic.key} className="topic" aria-labelledby={`topico-${topic.key}`}>
            <span className="kicker">{topic.kicker}</span>
            <h2 className="topic-title" id={`topico-${topic.key}`}>
              {topic.title}
            </h2>
            <ul>
              {articles.slice(0, PREVIEW).map((article) => (
                <li key={article.slug}>
                  <Link to={`/ajuda/${article.slug}`}>{article.title}</Link>
                </li>
              ))}
            </ul>
            <TopicMore topic={topic.key} count={articles.length} />
          </section>
        )
      })}
    </div>
  )
}

function TopicMore({ topic, count }: { topic: TopicKey; count: number }) {
  return (
    <Link className="topic-more" to={`/ajuda?topico=${topic}`}>
      Todos os {count} artigos →
    </Link>
  )
}

function TopicList({ topic }: { topic: Topic }) {
  return (
    <div className={styles.topicList}>
      <Link to="/ajuda" className={styles.back}>
        ← Todos os tópicos
      </Link>
      <span className="kicker">{topic.kicker}</span>
      <h2 className={styles.sectionTitle}>{topic.title}</h2>
      <ul className={`list ${styles.plainList}`} aria-label={topic.title}>
        {articlesByTopic(topic.key).map((article) => (
          <li key={article.slug} className="list-row">
            <Link className={`list-row-title ${styles.rowLink}`} to={`/ajuda/${article.slug}`}>
              {article.title}
            </Link>
            <span className="list-row-sub">{article.minutes} min de leitura</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Questions() {
  return (
    <section aria-labelledby="perguntas-frequentes" className={styles.questions}>
      <h2 id="perguntas-frequentes" className={styles.sectionTitle}>
        Perguntas frequentes
      </h2>
      <div className="faq">
        {QUESTIONS.map((item, index) => (
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
