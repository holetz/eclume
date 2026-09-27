import { useEffect, useRef, useState, type RefObject } from 'react'
import { Link, useParams } from 'react-router'
import { useHelpTopic } from '../../app/help'
import { PageHead } from '../../app/PageHead'
import { usePageTitle } from '../../app/usePageTitle'
import { ArticleBody } from './ArticleBody'
import { getArticle, getTopic, type Article } from './catalog'
import styles from './Help.module.css'

const updatedFormat = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' })

export function ArticlePage() {
  useHelpTopic('ajuda')
  const { slug = '' } = useParams()
  const article = getArticle(slug)
  if (!article) return <ArticleNotFound />
  return <ArticleView key={article.slug} article={article} />
}

function ArticleNotFound() {
  return (
    <section className={styles.page}>
      <PageHead kicker="Ajuda" title="Artigo não encontrado" />
      <p>
        Este artigo não existe ou mudou de endereço. Veja os tópicos na{' '}
        <Link to="/ajuda">central de ajuda</Link>.
      </p>
    </section>
  )
}

function ArticleView({ article }: { article: Article }) {
  usePageTitle(article.title)
  const topic = getTopic(article.topic)
  const body = useRef<HTMLDivElement>(null)
  const current = useCurrentHeading(body, article.headings[0]?.id)
  const related = article.related.map(getArticle).filter((item): item is Article => item !== undefined)

  return (
    <section className={styles.article}>
      <ol className="crumbs">
        <li>
          <Link to="/ajuda">Ajuda</Link>
        </li>
        <li>
          <Link to={`/ajuda?topico=${topic.key}`}>{topic.title}</Link>
        </li>
        <li aria-current="page">{article.title}</li>
      </ol>
      <div className={`page-head ${styles.articleHead}`}>
        <h1>{article.title}</h1>
        <div className="article-meta">
          <span>{article.minutes} min de leitura</span>
          <span>Atualizado em {updatedFormat.format(new Date(`${article.updated}T00:00:00Z`))}</span>
        </div>
      </div>
      <div className="help-article">
        <div ref={body} className={styles.articleMain}>
          <ArticleBody markdown={article.body} />
          {related.length > 0 && (
            <nav className={styles.related} aria-labelledby="artigos-relacionados">
              <span className="kicker" id="artigos-relacionados">
                Relacionados
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
          <nav className="toc" aria-label="Nesta página">
            <span className="toc-title">Nesta página</span>
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

/** A seção visível do artigo, pelo IntersectionObserver; sem ele (jsdom), vale a primeira. */
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
