import { describe, expect, it } from 'vitest'
import { buildCatalog } from './catalog'
import { normalize, queryTerms, searchArticles } from './search'

function art(slug: string, head: Partial<Record<'title' | 'topic' | 'terms' | 'order', string>>, body: string) {
  const data = { title: 'Sem título', topic: 'comecar', terms: '[]', order: '1', ...head }
  return [
    `./articles/pt-BR/${slug}.md`,
    `---\ntitle: ${data.title}\ntopic: ${data.topic}\npages: [ajuda]\nrelated: []\nterms: ${data.terms}\norder: ${data.order}\nupdated: 2026-09-27\n---\n${body}`,
  ] as const
}

const CATALOG = buildCatalog(
  Object.fromEntries([
    art('criar-token', { title: 'Crie um token de acesso', topic: 'conectar', order: '2' }, 'O token só aparece uma vez. Copie e guarde.'),
    art('revogar-token', { title: 'Revogue um token', topic: 'conectar', order: '3' }, 'Revogar corta o acesso na hora.'),
    art(
      'sugestoes',
      { title: 'Como funcionam as sugestões por voz', topic: 'transcricao', terms: '[impressão de voz, LGPD]' },
      '## Consentimento e remoção\n\nA impressão de voz é dado biométrico. Um token não muda nada aqui.',
    ),
    art('longo', { title: 'Um texto longo', order: '2' }, `${'Palavra qualquer. '.repeat(20)}O limiar decide. ${'Outra frase. '.repeat(20)}`),
  ]),
)

const slugs = (query: string) => searchArticles(query, CATALOG).map((hit) => hit.article.slug)

describe('normalization', () => {
  it('removes accents, punctuation and case, without changing the length', () => {
    expect(normalize('Remoção: já É!')).toBe('remocao  ja e ')
    expect(normalize('Remoção: já É!')).toHaveLength('Remoção: já É!'.length)
    expect(queryTerms('  O token, é?  token ')).toEqual(['token'])
  })
})

describe('help search', () => {
  it('matches without accents and by word prefix', () => {
    expect(slugs('sugestoes')).toEqual(['sugestoes'])
    expect(slugs('SUGEST')).toEqual(['sugestoes'])
    expect(slugs('biometr')).toEqual(['sugestoes'])
    expect(slugs('ometrico')).toEqual([])
  })

  it('requires every term', () => {
    expect(slugs('token revogar')).toEqual(['revogar-token'])
    expect(slugs('token girafa')).toEqual([])
  })

  it('weighs title above terms, ## headings and body; ties go by catalog order', () => {
    // "token" is in the title of two articles (5 + body 1) and only in the body of one (1).
    expect(slugs('token')).toEqual(['criar-token', 'revogar-token', 'sugestoes'])
    const [hit] = searchArticles('lgpd', CATALOG)
    expect(hit.score).toBe(4)
    expect(searchArticles('remocao', CATALOG)[0].score).toBe(3 + 1)
  })

  it('a short or empty query does not search', () => {
    expect(slugs('')).toEqual([])
    expect(slugs('a')).toEqual([])
  })

  it('returns the body snippet around the occurrence, with the term marked', () => {
    const [hit] = searchArticles('limiar', CATALOG)
    const { text, marks } = hit.snippet!
    expect(text.length).toBeLessThanOrEqual(162)
    expect(text.startsWith('…')).toBe(true)
    expect(text.endsWith('…')).toBe(true)
    expect(marks).toHaveLength(1)
    expect(text.slice(...marks[0])).toBe('limiar')

    const [accent] = searchArticles('biometrico', CATALOG)
    expect(accent.snippet!.text.slice(...accent.snippet!.marks[0])).toBe('biométrico')
  })

  it('with no occurrence in the body, there is no snippet', () => {
    expect(searchArticles('lgpd', CATALOG)[0].snippet).toBeNull()
  })

  it('respects the limit', () => {
    expect(searchArticles('token', CATALOG, 2)).toHaveLength(2)
  })
})
