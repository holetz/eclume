import { describe, expect, it } from 'vitest'
import {
  ARTICLES,
  articlesByTopic,
  articlesForPage,
  buildCatalog,
  getArticle,
  headingId,
  parseArticle,
  parseQuestions,
  QUESTIONS,
  TOPICS,
} from './catalog'
import { parseFrontmatter } from './frontmatter'
import { HELP_PAGES, type HelpPageKey } from './pages'

// O produto é por usuário (holetz/eclume#32): sem organização, sem convite, sem termo de
// consentimento por pessoa, sem compartilhamento entre contas, sem transcrição ao vivo e sem os
// templates de resumo (que viraram instruções do tipo de agenda).
const FORBIDDEN: RegExp[] = [
  /organiza[çc](ão|ões|ao|oes)/i,
  /\btenant/i,
  /\bconvit[ea]|\bconvidad/i,
  /termo de consentimento/i,
  /consentimento de voz/i,
  /ao vivo/i,
  /compartilhad[ao]s? com/i,
  /\btemplates?\b/i,
]

// Rotas do app que um artigo pode citar num link interno.
const APP_ROUTES = [
  /^\/$/,
  /^\/busca$/,
  /^\/perguntas$/,
  /^\/pessoas$/,
  /^\/colecoes$/,
  /^\/tags$/,
  /^\/config\/(campos|agendas|mcp)$/,
  /^\/tokens$/,
  /^\/app-(desktop|movel)$/,
  /^\/ajuda$/,
  /^\/downloads\/[\w.-]+$/,
]

const links = (markdown: string) => [...markdown.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1])

describe('artigos da central de ajuda', () => {
  it('existem e têm slug em kebab-case, único', () => {
    expect(ARTICLES.length).toBeGreaterThan(0)
    for (const article of ARTICLES) expect(article.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    expect(new Set(ARTICLES.map((a) => a.slug)).size).toBe(ARTICLES.length)
  })

  it('cobrem a central inteira: 41 artigos, três ou mais por tópico e um ou mais por chave de página', () => {
    expect(ARTICLES).toHaveLength(41)
    for (const topic of TOPICS) expect(articlesByTopic(topic.key).length, topic.key).toBeGreaterThanOrEqual(3)
    for (const key of Object.keys(HELP_PAGES) as HelpPageKey[]) {
      expect(articlesForPage(key).length, `chave ${key}`).toBeGreaterThanOrEqual(1)
    }
  })

  it.each(ARTICLES.map((a) => [a.slug, a] as const))('%s: cabeçalho, títulos e relacionados válidos', (slug, article) => {
    expect(article.title.length).toBeGreaterThan(3)
    expect(article.pages.length).toBeGreaterThan(0)
    expect(article.related).not.toContain(slug)
    for (const related of article.related) expect(getArticle(related), `relacionado "${related}"`).toBeDefined()
    const ids = article.headings.map((h) => h.id)
    expect(new Set(ids).size, 'títulos ## repetidos').toBe(ids.length)
    expect(article.body, 'o título do artigo vem do cabeçalho, não de um #').not.toMatch(/^# /m)
  })

  it.each(ARTICLES.map((a) => [a.slug, a] as const))('%s: links internos apontam para artigos e telas que existem', (_, article) => {
    for (const href of links(article.body)) {
      if (/^https?:\/\//.test(href)) continue
      const help = /^\/ajuda\/([a-z0-9-]+)(?:#([a-z0-9-]+))?$/.exec(href)
      if (help) {
        const target = getArticle(help[1])
        expect(target, `link para o artigo "${help[1]}"`).toBeDefined()
        if (help[2]) expect(target!.headings.map((h) => h.id), `âncora "${href}"`).toContain(help[2])
        continue
      }
      expect(APP_ROUTES.some((route) => route.test(href)), `link "${href}"`).toBe(true)
    }
  })

  it.each(ARTICLES.map((a) => [a.slug, a] as const))('%s: sem termos do produto antigo', (_, article) => {
    const text = [article.title, article.terms.join(' '), article.body].join('\n')
    for (const term of FORBIDDEN) expect(text, `termo proibido ${term}`).not.toMatch(term)
  })

  it('o artigo das sugestões por voz é o do DS, sem organização', () => {
    const article = getArticle('sugestoes-por-voz')!
    expect(article.topic).toBe('transcricao')
    expect(article.headings.map((h) => h.text)).toEqual([
      'O que é uma impressão de voz',
      'Quando o eclume sugere uma pessoa',
      'Atribuição automática',
      'Consentimento e remoção',
    ])
    expect(article.headings[0].id).toBe('o-que-e-uma-impressao-de-voz')
    expect(articlesForPage('pessoa')).toContain(article)
  })
})

describe('perguntas frequentes', () => {
  it('têm pergunta e resposta, sem termos do produto antigo', () => {
    expect(QUESTIONS).toHaveLength(6)
    for (const { question, answer } of QUESTIONS) {
      expect(question).toMatch(/\?$/)
      expect(answer.length).toBeGreaterThan(20)
      for (const term of FORBIDDEN) expect(`${question}\n${answer}`).not.toMatch(term)
    }
    expect(QUESTIONS[1]).toMatchObject({ question: 'Quem vê minhas gravações?' })
  })

  it('cada ## é uma pergunta, e o texto até o próximo é a resposta', () => {
    expect(parseQuestions('## Um?\n\nResposta um.\n\n## Dois?\nResposta\ndois.')).toEqual([
      { question: 'Um?', answer: 'Resposta um.' },
      { question: 'Dois?', answer: 'Resposta\ndois.' },
    ])
  })
})

const HEAD = 'titulo: Um artigo\ntopico: comecar\npaginas: [biblioteca]\nrelacionados: []\ntermos: [a, b]\nordem: 1\natualizado: 2026-09-27'
const article = (head: string, body = 'Texto.') => `---\n${head}\n---\n${body}`

describe('leitor do cabeçalho', () => {
  it('lê valores e listas, com CRLF', () => {
    expect(parseFrontmatter('---\r\ntitulo: Olá: mundo\r\ntermos: [a, b c]\r\nvazia: []\r\n---\r\nCorpo', 'x.md')).toEqual({
      data: { titulo: 'Olá: mundo', termos: ['a', 'b c'], vazia: [] },
      body: 'Corpo',
    })
  })

  it('lança com o nome do arquivo', () => {
    expect(() => parseFrontmatter('sem cabeçalho', 'a.md')).toThrow(/^a\.md: /)
    expect(() => parseFrontmatter('---\ntitulo: x\n', 'b.md')).toThrow(/b\.md: o cabeçalho não fecha/)
    expect(() => parseFrontmatter('---\n- item\n---\n', 'c.md')).toThrow(/c\.md: linha inválida/)
    expect(() => parseFrontmatter('---\nt: [a, b\n---\n', 'd.md')).toThrow(/d\.md: a lista/)
    expect(() => parseFrontmatter('---\nt: a\nt: b\n---\n', 'e.md')).toThrow(/duas vezes/)
  })
})

describe('validação de um artigo', () => {
  it('monta slug, títulos, texto puro e minutos de leitura', () => {
    const body = `Abertura com [link](/ajuda/outro) e **negrito**.\n\n## Primeiro passo\n\n${'palavra '.repeat(390)}`
    const parsed = parseArticle('./articles/um-artigo.md', article(HEAD, body))
    expect(parsed).toMatchObject({ slug: 'um-artigo', title: 'Um artigo', topic: 'comecar', order: 1 })
    expect(parsed.headings).toEqual([{ id: 'primeiro-passo', text: 'Primeiro passo' }])
    expect(parsed.plain.startsWith('Abertura com link e negrito. Primeiro passo palavra')).toBe(true)
    expect(parsed.minutes).toBe(2)
  })

  it.each([
    [HEAD.replace('topico: comecar', 'topico: outro'), /tópico desconhecido "outro"/],
    [HEAD.replace('[biblioteca]', '[inexistente]'), /chave de página desconhecida "inexistente"/],
    [HEAD.replace('ordem: 1', 'ordem: primeiro'), /"ordem"/],
    [HEAD.replace('2026-09-27', '27/09/2026'), /"atualizado"/],
    [HEAD.replace('titulo: Um artigo\n', ''), /falta "titulo"/],
    [HEAD.replace('termos: [a, b]', 'termos: a'), /"termos" precisa ser uma lista/],
    [`${HEAD}\nautor: alguém`, /chave desconhecida "autor"/],
  ])('recusa cabeçalho inválido (%#)', (head, error) => {
    expect(() => parseArticle('./articles/x.md', article(head))).toThrow(error)
  })

  it('ordena por tópico e depois por ordem', () => {
    const catalog = buildCatalog({
      './articles/b.md': article(HEAD.replace('topico: comecar', 'topico: conectar')),
      './articles/c.md': article(HEAD.replace('ordem: 1', 'ordem: 2')),
      './articles/a.md': article(HEAD.replace('ordem: 1', 'ordem: 3')),
    })
    expect(catalog.map((a) => a.slug)).toEqual(['c', 'a', 'b'])
  })

  it('o id do título tira acento e pontuação', () => {
    expect(headingId('Consentimento e remoção: o que fazer?')).toBe('consentimento-e-remocao-o-que-fazer')
  })

  it('os seis tópicos seguem a ordem do DS', () => {
    expect(TOPICS.map((t) => t.key)).toEqual(['comecar', 'processamento', 'transcricao', 'resumos', 'organizar', 'conectar'])
  })
})
