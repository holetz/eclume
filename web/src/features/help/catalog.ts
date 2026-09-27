// Catálogo da central de ajuda: os artigos Markdown de ./articles, lidos no build. Só a central e o
// corpo da gaveta importam este módulo, e os dois são chunks sob demanda: os artigos não pesam no
// bundle inicial.
import { parseFrontmatter, type FrontmatterValue } from './frontmatter'
import { isHelpPageKey, type HelpPageKey } from './pages'
import perguntas from './perguntas.md?raw'
import { normalize } from './search'

export const TOPICS = [
  { key: 'comecar', kicker: 'Início', title: 'Primeiros passos' },
  { key: 'processamento', kicker: 'Gravações', title: 'Processamento e falhas' },
  { key: 'transcricao', kicker: 'Gravações', title: 'Transcrição e locutores' },
  { key: 'resumos', kicker: 'Gravações', title: 'Resumos e chat' },
  { key: 'organizar', kicker: 'Organizar', title: 'Campos, regras e tipos de agenda' },
  { key: 'conectar', kicker: 'Conectar', title: 'Assistentes, tokens e aparelhos' },
] as const

export type TopicKey = (typeof TOPICS)[number]['key']
export type Topic = (typeof TOPICS)[number]

export interface Heading {
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
  /** Data da última revisão, `AAAA-MM-DD`. */
  updated: string
  body: string
  /** O corpo sem a marcação do Markdown, para a busca. */
  plain: string
  headings: Heading[]
  minutes: number
}

export interface Question {
  question: string
  answer: string
}

/** O `id` de um título `##`: o texto normalizado, com hífens. */
export function headingId(text: string): string {
  return normalize(text).trim().split(/\s+/).join('-')
}

/** O texto de um trecho Markdown sem a marcação: links viram o rótulo, ênfase e código somem. */
export function plainText(markdown: string): string {
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

/** Lê e valida um artigo; lança com o nome do arquivo no primeiro problema. */
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

/** Os artigos em ordem de tópico e, dentro dele, de `ordem`. */
export function buildCatalog(files: Record<string, string>): Article[] {
  return Object.entries(files)
    .map(([file, raw]) => parseArticle(file, raw))
    .sort((a, b) => topicRank(a.topic) - topicRank(b.topic) || a.order - b.order || a.slug.localeCompare(b.slug))
}

/** As perguntas frequentes: cada `##` é uma pergunta, e o texto até o próximo é a resposta. */
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
