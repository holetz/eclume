// Local search for the help center: no server, accent-insensitive, by word prefix. With ~34
// articles, the linear scan answers in under 1 ms.
import type { Article } from './catalog'

/**
 * Lowercase, without accents and without punctuation, character by character: the result has the
 * same length as the text, so a position found in the normalized text holds in the original (the
 * search snippet).
 */
export function normalize(text: string): string {
  let out = ''
  for (const char of text) {
    const base = char.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    const one = base.length === 1 && /[\p{L}\p{N}]/u.test(base) ? base : ' '
    // Characters outside the BMP take two positions in the original text.
    out += char.length === 2 ? `${one} ` : one
  }
  return out
}

/** The query terms: normalized words of 2 characters or more. */
export function queryTerms(query: string): string[] {
  return [...new Set(normalize(query).split(/\s+/).filter((term) => term.length >= 2))]
}

const WEIGHTS = { title: 5, terms: 4, headings: 3, body: 1 } as const
type Field = keyof typeof WEIGHTS

interface Indexed {
  article: Article
  fields: Record<Field, string>
}

export interface SearchHit {
  article: Article
  score: number
  /** Up to 160 characters of the body around the first occurrence, with the terms marked. */
  snippet: { text: string; marks: [number, number][] } | null
}

const indexes = new WeakMap<readonly Article[], Indexed[]>()

function indexOf(articles: readonly Article[]): Indexed[] {
  let index = indexes.get(articles)
  if (!index) {
    index = articles.map((article) => ({
      article,
      fields: {
        title: ` ${normalize(article.title)}`,
        terms: ` ${normalize(article.terms.join(' '))}`,
        headings: ` ${normalize(article.headings.map((h) => h.text).join(' '))}`,
        body: ` ${normalize(article.plain)}`,
      },
    }))
    indexes.set(articles, index)
  }
  return index
}

/** Position of the first word in the text that starts with the term, or -1 (fields with a leading space). */
function wordStart(field: string, term: string): number {
  const at = field.indexOf(` ${term}`)
  return at < 0 ? -1 : at
}

const SNIPPET = 160

/** `body` is the indexed field (space + normalized body): index i of the body is its i + 1. */
function snippetOf(plain: string, body: string, terms: string[]): SearchHit['snippet'] {
  const positions = terms.map((term) => wordStart(body, term)).filter((at) => at >= 0)
  if (positions.length === 0) return null
  const end = Math.min(plain.length, Math.max(0, Math.min(...positions) - 60) + SNIPPET)
  const start = Math.max(0, end - SNIPPET)
  const prefix = start > 0 ? '…' : ''
  const window = body.slice(1 + start, 1 + end)
  const marks: [number, number][] = []
  for (const term of terms) {
    for (let at = window.indexOf(term); at >= 0; at = window.indexOf(term, at + 1)) {
      if (body[start + at] === ' ') marks.push([prefix.length + at, prefix.length + at + term.length])
    }
  }
  marks.sort((a, b) => a[0] - b[0])
  const merged = marks.reduce<[number, number][]>((out, mark) => {
    const last = out.at(-1)
    if (last && mark[0] <= last[1]) last[1] = Math.max(last[1], mark[1])
    else out.push([...mark])
    return out
  }, [])
  return { text: `${prefix}${plain.slice(start, end)}${end < plain.length ? '…' : ''}`, marks: merged }
}

/** Articles where every term matches, from most to least relevant; ties go by catalog order. */
export function searchArticles(query: string, articles: readonly Article[], limit = Infinity): SearchHit[] {
  const terms = queryTerms(query)
  if (terms.length === 0) return []
  const hits: (SearchHit & { rank: number })[] = []
  indexOf(articles).forEach(({ article, fields }, rank) => {
    let score = 0
    for (const term of terms) {
      let termScore = 0
      for (const field of Object.keys(WEIGHTS) as Field[]) {
        if (wordStart(fields[field], term) >= 0) termScore += WEIGHTS[field]
      }
      if (termScore === 0) return
      score += termScore
    }
    hits.push({ article, score, rank, snippet: snippetOf(article.plain, fields.body, terms) })
  })
  return hits
    .sort((a, b) => b.score - a.score || a.rank - b.rank)
    .slice(0, limit)
    .map(({ article, score, snippet }) => ({ article, score, snippet }))
}
