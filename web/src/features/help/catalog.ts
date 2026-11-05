// Help center catalog: the Markdown articles in ./articles, read at build time. Only the center and
// the drawer body import this module, and both are on-demand chunks: the articles add no weight to
// the initial bundle.
import { useTranslation } from 'react-i18next'
import { parseFrontmatter, type FrontmatterValue } from './frontmatter'
import { isHelpPageKey, type HelpPageKey } from './pages'
import { DEFAULT_LOCALE, type Locale } from '../../i18n/locale'
import faqEn from './faq/en.md?raw'
import faqPtBR from './faq/pt-BR.md?raw'
import { normalize } from './search'

/** The topic keys, in display order. The kicker and title of each are `help:topic.<key>`. */
export const TOPIC_KEYS = ['comecar', 'processamento', 'transcricao', 'resumos', 'organizar', 'conectar'] as const

export type TopicKey = (typeof TOPIC_KEYS)[number]

interface Heading {
  id: string
  text: string
}

export interface Article {
  slug: string
  title: string
  topic: TopicKey
  pages: HelpPageKey[]
  related: string[]
  terms: string[]
  order: number
  /** Date of the last review, `YYYY-MM-DD`. */
  updated: string
  body: string
  /** The body without Markdown markup, for search. */
  plain: string
  headings: Heading[]
  minutes: number
}

export interface Question {
  question: string
  answer: string
}

/** The `id` of a `##` heading: the normalized text, with hyphens. */
export function headingId(text: string): string {
  return normalize(text).trim().split(/\s+/).join('-')
}

/** The text of a Markdown snippet without markup: links become their label, emphasis and code go away. */
function plainText(markdown: string): string {
  return markdown
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function text(data: Record<string, FrontmatterValue>, key: string, file: string): string {
  const value = data[key]
  if (typeof value !== 'string' || !value) throw new Error(`${file}: missing "${key}" in the header.`)
  return value
}

function list(data: Record<string, FrontmatterValue>, key: string, file: string): string[] {
  const value = data[key]
  if (!Array.isArray(value)) throw new Error(`${file}: "${key}" must be a bracketed list.`)
  return value
}

const KNOWN_KEYS = new Set(['title', 'topic', 'pages', 'related', 'terms', 'order', 'updated'])

/** Reads and validates an article; throws with the file name on the first problem. */
export function parseArticle(file: string, raw: string): Article {
  const slug = file.replace(/^.*\//, '').replace(/\.md$/, '')
  const { data, body } = parseFrontmatter(raw, file)
  for (const key of Object.keys(data)) {
    if (!KNOWN_KEYS.has(key)) throw new Error(`${file}: unknown key "${key}" in the header.`)
  }
  const topic = text(data, 'topic', file)
  if (!(TOPIC_KEYS as readonly string[]).includes(topic)) throw new Error(`${file}: unknown topic "${topic}".`)
  const pages = list(data, 'pages', file)
  const unknownPage = pages.find((page) => !isHelpPageKey(page))
  if (unknownPage) throw new Error(`${file}: unknown page key "${unknownPage}".`)
  const order = Number(text(data, 'order', file))
  if (!Number.isInteger(order) || order < 1) throw new Error(`${file}: "order" must be an integer from 1.`)
  const updated = text(data, 'updated', file)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(updated)) throw new Error(`${file}: "updated" must be YYYY-MM-DD.`)
  if (!body) throw new Error(`${file}: the article has no body.`)

  const headings = [...body.matchAll(/^## +(.+)$/gm)].map((match) => {
    const heading = plainText(match[1])
    return { id: headingId(heading), text: heading }
  })
  const plain = plainText(body)
  return {
    slug,
    title: text(data, 'title', file),
    topic: topic as TopicKey,
    pages: pages as HelpPageKey[],
    related: list(data, 'related', file),
    terms: list(data, 'terms', file),
    order,
    updated,
    body,
    plain,
    headings,
    minutes: Math.max(1, Math.ceil(plain.split(' ').length / 200)),
  }
}

const topicRank = (topic: TopicKey) => TOPIC_KEYS.indexOf(topic)

/** The articles in topic order and, within a topic, by `ordem`. */
export function buildCatalog(files: Record<string, string>): Article[] {
  return Object.entries(files)
    .map(([file, raw]) => parseArticle(file, raw))
    .sort((a, b) => topicRank(a.topic) - topicRank(b.topic) || a.order - b.order || a.slug.localeCompare(b.slug))
}

/** The frequently asked questions: each `##` is a question, and the text up to the next one is the answer. */
export function parseQuestions(markdown: string): Question[] {
  return markdown
    .replace(/\r\n?/g, '\n')
    .split(/^## +/m)
    .slice(1)
    .map((block) => {
      const [question, ...answer] = block.split('\n')
      return { question: question.trim(), answer: answer.join('\n').trim() }
    })
}

/** The article set and the frequently asked questions of one locale. */
export interface HelpCatalog {
  articles: readonly Article[]
  questions: readonly Question[]
}

const FILES = import.meta.glob<string>('./articles/*/*.md', { query: '?raw', import: 'default', eager: true })

function filesOf(locale: Locale): Record<string, string> {
  return Object.fromEntries(Object.entries(FILES).filter(([file]) => file.startsWith(`./articles/${locale}/`)))
}

/** Every locale carries every article id (a test holds this), so the fallback only guards an unknown locale. */
export const CATALOGS: Record<Locale, HelpCatalog> = {
  en: { articles: buildCatalog(filesOf('en')), questions: parseQuestions(faqEn) },
  'pt-BR': { articles: buildCatalog(filesOf('pt-BR')), questions: parseQuestions(faqPtBR) },
}

/** The help set for the locale, falling back to `en`. */
export function helpCatalog(locale: Locale | string | null | undefined): HelpCatalog {
  return CATALOGS[locale as Locale] ?? CATALOGS[DEFAULT_LOCALE]
}

export function articlesByTopic(catalog: HelpCatalog, topic: TopicKey): Article[] {
  return catalog.articles.filter((article) => article.topic === topic)
}

export function articlesForPage(catalog: HelpCatalog, key: HelpPageKey): Article[] {
  return catalog.articles.filter((article) => article.pages.includes(key))
}

export function getArticle(catalog: HelpCatalog, slug: string): Article | undefined {
  return catalog.articles.find((article) => article.slug === slug)
}

/** The help set for the active UI locale; a locale switch re-renders the caller. */
export function useHelpCatalog(): HelpCatalog {
  const { i18n } = useTranslation()
  return helpCatalog(i18n.language)
}
