// Help center catalog: the Markdown articles in ./articles, read at build time. Only the center and
// the drawer body import this module, and both are on-demand chunks: the articles add no weight to
// the initial bundle.
import { i18n } from '../../i18n'
import { parseFrontmatter, type FrontmatterValue } from './frontmatter'
import { isHelpPageKey, type HelpPageKey } from './pages'
import perguntas from './perguntas.md?raw'
import { normalize } from './search'

/** One help topic: the key, with the kicker and the title read from the `help` catalog when used. */
function topic<K extends 'comecar' | 'processamento' | 'transcricao' | 'resumos' | 'organizar' | 'conectar'>(key: K) {
  return {
    key,
    get kicker(): string {
      return i18n.t(`help:topic.${key}.kicker`)
    },
    get title(): string {
      return i18n.t(`help:topic.${key}.title`)
    },
  }
}

export const TOPICS = [
  topic('comecar'),
  topic('processamento'),
  topic('transcricao'),
  topic('resumos'),
  topic('organizar'),
  topic('conectar'),
] as const

export type TopicKey = (typeof TOPICS)[number]['key']
export type Topic = (typeof TOPICS)[number]

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

interface Question {
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
  if (typeof value !== 'string' || !value) throw new Error(`${file}: falta "${key}" no cabeçalho.`)
  return value
}

function list(data: Record<string, FrontmatterValue>, key: string, file: string): string[] {
  const value = data[key]
  if (!Array.isArray(value)) throw new Error(`${file}: "${key}" precisa ser uma lista entre colchetes.`)
  return value
}

const KNOWN_KEYS = new Set(['titulo', 'topico', 'paginas', 'relacionados', 'termos', 'ordem', 'atualizado'])

/** Reads and validates an article; throws with the file name on the first problem. */
export function parseArticle(file: string, raw: string): Article {
  const slug = file.replace(/^.*\//, '').replace(/\.md$/, '')
  const { data, body } = parseFrontmatter(raw, file)
  for (const key of Object.keys(data)) {
    if (!KNOWN_KEYS.has(key)) throw new Error(`${file}: chave desconhecida "${key}" no cabeçalho.`)
  }
  const topic = text(data, 'topico', file)
  if (!TOPICS.some((t) => t.key === topic)) throw new Error(`${file}: tópico desconhecido "${topic}".`)
  const pages = list(data, 'paginas', file)
  const unknownPage = pages.find((page) => !isHelpPageKey(page))
  if (unknownPage) throw new Error(`${file}: chave de página desconhecida "${unknownPage}".`)
  const order = Number(text(data, 'ordem', file))
  if (!Number.isInteger(order) || order < 1) throw new Error(`${file}: "ordem" precisa ser um inteiro a partir de 1.`)
  const updated = text(data, 'atualizado', file)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(updated)) throw new Error(`${file}: "atualizado" precisa ser AAAA-MM-DD.`)
  if (!body) throw new Error(`${file}: o artigo não tem corpo.`)

  const headings = [...body.matchAll(/^## +(.+)$/gm)].map((match) => {
    const heading = plainText(match[1])
    return { id: headingId(heading), text: heading }
  })
  const plain = plainText(body)
  return {
    slug,
    title: text(data, 'titulo', file),
    topic: topic as TopicKey,
    pages: pages as HelpPageKey[],
    related: list(data, 'relacionados', file),
    terms: list(data, 'termos', file),
    order,
    updated,
    body,
    plain,
    headings,
    minutes: Math.max(1, Math.ceil(plain.split(' ').length / 200)),
  }
}

const topicRank = (topic: TopicKey) => TOPICS.findIndex((t) => t.key === topic)

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

const FILES = import.meta.glob<string>('./articles/*.md', { query: '?raw', import: 'default', eager: true })

export const ARTICLES: readonly Article[] = buildCatalog(FILES)
export const QUESTIONS: readonly Question[] = parseQuestions(perguntas)

export function articlesByTopic(topic: TopicKey): Article[] {
  return ARTICLES.filter((article) => article.topic === topic)
}

export function articlesForPage(key: HelpPageKey): Article[] {
  return ARTICLES.filter((article) => article.pages.includes(key))
}

export function getArticle(slug: string): Article | undefined {
  return ARTICLES.find((article) => article.slug === slug)
}

export function getTopic(key: TopicKey): Topic {
  return TOPICS.find((topic) => topic.key === key)!
}
