import { describe, expect, it } from 'vitest'
import en from '../../i18n/en'
import { LOCALES, type Locale } from '../../i18n/locale'
import ptBR from '../../i18n/pt-BR'
import enHelp from '../../i18n/en/help'
import ptBRHelp from '../../i18n/pt-BR/help'
import {
  articlesByTopic,
  articlesForPage,
  buildCatalog,
  CATALOGS,
  getArticle,
  headingId,
  helpCatalog,
  parseArticle,
  parseQuestions,
  TOPIC_KEYS,
} from './catalog'
import { parseFrontmatter } from './frontmatter'
import { HELP_PAGES } from './pages'

// The product is per user (holetz/eclume#32): no organization, no invitation, no per-person consent
// form, no sharing between accounts, no live transcription and no summary templates (which became
// agenda type instructions). One list per locale.
const FORBIDDEN: Record<Locale, RegExp[]> = {
  'pt-BR': [
    /organiza[çc](ão|ões|ao|oes)/i,
    /\btenant/i,
    /\bconvit[ea]|\bconvidad/i,
    /termo de consentimento/i,
    /consentimento de voz/i,
    /ao vivo/i,
    /compartilhad[ao]s? com/i,
    /\btemplates?\b/i,
  ],
  en: [
    /\borganizations?\b/i,
    /\btenant/i,
    /\binvit(e|es|ed|ation|ations)\b/i,
    /consent form/i,
    /voice consent/i,
    /\blive (transcri|record)/i,
    /\bshared with\b/i,
    /\btemplates?\b/i,
  ],
}

// App routes an article may cite in an internal link.
const APP_ROUTES = [
  /^\/$/,
  /^\/busca$/,
  /^\/agente(\/conversas|\/habilidades)?$/,
  /^\/pessoas$/,
  /^\/colecoes$/,
  /^\/tags$/,
  /^\/config\/(campos|agendas|mcp)$/,
  /^\/tokens$/,
  /^\/app-(desktop|movel)$/,
  /^\/ajuda$/,
  /^\/downloads\/[\w.-]+$/,
  /^\/referencia-api\.html$/,
]

const links = (markdown: string) => [...markdown.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1])

// Bold text an article cites that is not a string of the web catalogs: labels of the desktop and
// phone apps, of the operating system, of the agent screens (their catalog is still to come), server
// seeds and emphasis. Anything else bold must be a catalog string of the same locale.
const OUTSIDE: Record<Locale, string[]> = {
  'pt-BR': [
    '"O certificado do servidor mudou"',
    '1:1',
    'A transcrição é dado, não ordem',
    'Abrir na web',
    'Agente fora do ar ou com resposta inválida',
    'Agente sem configuração',
    'Anexar',
    'Atrás das suas gravações',
    'Certificado de CA',
    'Coleções com regra',
    'Combine com quem vai ser gravado',
    'Configurações → Apps → eclume → Permissões',
    'Configurações → Privacidade e segurança → Microfone',
    'Configurações → Sistema → Som → Entrada',
    'Corte do silêncio',
    'Criar atalhos no GNOME',
    'DOCX',
    'Desligada por padrão',
    'Escolher pasta…',
    'Exigir a marcação dos locutores',
    'Ferramentas',
    'Gravação salva',
    'Incluir as transcrições',
    'Limitar as ferramentas',
    'Linux',
    'Locutores pela voz',
    'MD',
    'Manual',
    'Marcação dos locutores',
    'Minutos de 24 h esgotados',
    'Na fila do processador',
    'Na pasta sincronizada',
    'Nenhum agente configurado para preencher campos',
    'No resumo',
    'Normalização do volume',
    'Notas dos marcadores',
    'Nova conversa',
    'Nova habilidade',
    'Nova nota',
    'O arquivo não abre',
    'O processador de transcrição não respondeu',
    'Os participantes identificados',
    'Padrão do servidor: Português',
    'Permitir',
    'Permitir que aplicativos da área de trabalho acessem o microfone',
    'Permitir só durante o uso do app',
    'Processador fora do ar',
    'Pré-processamento e transcrição',
    'Redução de ruído',
    'Reunião de equipe',
    'SRT',
    'Sem gravações transcritas',
    'Separação de canais',
    'Sincronizar agora',
    'Sincronizar resumos numa pasta',
    'Somem',
    'TXT',
    'Teto do cadastro',
    'aceitou',
    'agrupa gravações que você escolhe',
    'cliente-metalurgica',
    'editou',
    'espelho',
    'impressão digital',
    'notificações',
    'original',
    'pela rede',
    'pelo QR',
    'pelo instalador',
    'sem texto legível',
    'seus campos',
    'subpastas',
    'vault',
    '×',
  ],
  en: [
    '"The server certificate changed"',
    '1:1',
    '24-hour minutes used up',
    'Accepted',
    'Agent not configured',
    'Agent offline or with an invalid response',
    'Agree with whoever is recorded',
    'Allow only while using the app',
    'Attach',
    'Behind your recordings',
    'CA certificate',
    'Channel separation',
    'Choose folder…',
    'Collections with a rule',
    'Connectors',
    'Conversa com cliente',
    'Create GNOME shortcuts',
    'Ctrl + wheel',
    'DOCX',
    'Geral',
    'In the summary',
    'In the synced folder',
    'Include transcripts',
    'Input',
    'Let desktop apps access your microphone',
    'Limit the tools',
    'Linux',
    'MD',
    'Manual',
    'Marker notes',
    'Microphone access',
    'Name.',
    'New conversation',
    'New note',
    'New skill',
    'No agent configured to fill fields',
    'Noise reduction',
    'Nota de voz',
    'Off by default',
    'Open on the web',
    'Preprocessing and transcription',
    'Processor offline',
    'Recording saved',
    'Registry ceiling',
    'Require speaker naming',
    'Reunião de equipe',
    'SRT',
    'Server default: Portuguese',
    'Settings → Apps → eclume → Permissions',
    'Settings → Privacy & security → Microphone',
    'Settings → System → Sound → Input',
    'Silence trimming',
    'Speaker naming',
    'Speakers by voice',
    'Sync now',
    'Sync summaries to a folder',
    'TXT',
    'The file does not open',
    'The identified participants',
    'The transcript is data, not an order',
    'The transcription processor did not answer',
    'Tools',
    'Variants',
    'Volume normalization',
    'Waiting for the processor',
    'Your fields',
    'accepted',
    'fingerprint',
    'groups recordings you choose',
    'mirror',
    'no readable text',
    'original',
    'over the network',
    'steelworks-customer',
    'subfolders',
    'through the QR',
    'through the installer',
    'vault',
    '×',
  ],
}

const flatten = (node: unknown): string[] =>
  typeof node === 'string' ? [node] : Object.values(node as object).flatMap(flatten)
const catalogText = (locale: Locale) =>
  flatten(locale === 'en' ? en : ptBR)
    .join('\n')
    .toLowerCase()

const squash = (text: string) => text.replace(/\s+/g, ' ').trim()

describe.each(LOCALES)('help center articles (%s)', (locale) => {
  const catalog = CATALOGS[locale]
  const { articles } = catalog

  it('exist and have a unique kebab-case slug', () => {
    expect(articles.length).toBeGreaterThan(0)
    for (const article of articles) expect(article.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    expect(new Set(articles.map((a) => a.slug)).size).toBe(articles.length)
  })

  it('cover the whole center: 44 articles, three or more per topic and one or more per page key', () => {
    expect(articles).toHaveLength(44)
    for (const key of TOPIC_KEYS) expect(articlesByTopic(catalog, key).length, key).toBeGreaterThanOrEqual(3)
    for (const key of HELP_PAGES) expect(articlesForPage(catalog, key).length, `page key ${key}`).toBeGreaterThanOrEqual(1)
  })

  it.each(articles.map((a) => [a.slug, a] as const))('%s: valid header, headings and related', (slug, article) => {
    expect(article.title.length).toBeGreaterThan(3)
    expect(article.pages.length).toBeGreaterThan(0)
    expect(article.related).not.toContain(slug)
    for (const related of article.related) expect(getArticle(catalog, related), `related "${related}"`).toBeDefined()
    const ids = article.headings.map((h) => h.id)
    expect(new Set(ids).size, 'repeated ## headings').toBe(ids.length)
    expect(article.body, 'the title comes from the header, not from a #').not.toMatch(/^# /m)
  })

  it.each(articles.map((a) => [a.slug, a] as const))('%s: internal links point to articles and screens that exist', (_, article) => {
    for (const href of links(article.body)) {
      if (/^https?:\/\//.test(href)) continue
      const help = /^\/ajuda\/([a-z0-9-]+)(?:#([a-z0-9-]+))?$/.exec(href)
      if (help) {
        const target = getArticle(catalog, help[1])
        expect(target, `link to article "${help[1]}"`).toBeDefined()
        if (help[2]) expect(target!.headings.map((h) => h.id), `anchor "${href}"`).toContain(help[2])
        continue
      }
      expect(APP_ROUTES.some((route) => route.test(href)), `link "${href}"`).toBe(true)
    }
  })

  it.each(articles.map((a) => [a.slug, a] as const))('%s: no terms of the old product', (_, article) => {
    const text = [article.title, article.terms.join(' '), article.body].join('\n')
    for (const term of FORBIDDEN[locale]) expect(text, `forbidden term ${term}`).not.toMatch(term)
  })

  it('every bold label an article cites is a catalog string of this locale', () => {
    const known = catalogText(locale)
    const outside = new Set(OUTSIDE[locale].map((label) => label.toLowerCase()))
    const missing: string[] = []
    for (const article of articles) {
      for (const match of article.body.matchAll(/\*\*([^*]+)\*\*/g)) {
        for (const part of squash(match[1]).replace(/:$/, '').split(/\s*[›]\s*/)) {
          const label = part.toLowerCase()
          if (!known.includes(label) && !outside.has(label)) missing.push(`${article.slug}: ${part}`)
        }
      }
    }
    expect(missing).toEqual([])
  })

  it('the frequently asked questions have six entries without terms of the old product', () => {
    expect(catalog.questions).toHaveLength(6)
    for (const { question, answer } of catalog.questions) {
      expect(question).toMatch(/\?$/)
      expect(answer.length).toBeGreaterThan(20)
      for (const term of FORBIDDEN[locale]) expect(`${question}\n${answer}`).not.toMatch(term)
    }
  })
})

describe('the two locales', () => {
  it('carry the same article ids, with the same topic, pages, order and related', () => {
    const summary = (locale: Locale) =>
      CATALOGS[locale].articles.map((a) => [a.slug, a.topic, a.pages, a.order, a.related, a.headings.length] as const)
    expect(summary('en')).toEqual(summary('pt-BR'))
  })

  it('answer the same number of frequently asked questions', () => {
    expect(CATALOGS.en.questions).toHaveLength(CATALOGS['pt-BR'].questions.length)
  })

  it('fall back to en for an unknown locale', () => {
    expect(helpCatalog('fr')).toBe(CATALOGS.en)
    expect(helpCatalog('pt-BR')).toBe(CATALOGS['pt-BR'])
    expect(helpCatalog(null)).toBe(CATALOGS.en)
  })

  it('every topic and page key has a label in both help catalogs', () => {
    for (const help of [enHelp, ptBRHelp]) {
      for (const key of TOPIC_KEYS) expect(help.topic[key].title.length, key).toBeGreaterThan(0)
      for (const key of HELP_PAGES) expect(help.page[key].length, key).toBeGreaterThan(0)
    }
  })

  it('the voice suggestions article is the DS one, without organization', () => {
    const article = getArticle(CATALOGS['pt-BR'], 'voice-suggestions')!
    expect(article.topic).toBe('transcricao')
    expect(article.headings.map((h) => h.text)).toEqual([
      'O que é uma impressão de voz',
      'Quando o eclume sugere uma pessoa',
      'Atribuição automática',
      'Consentimento e remoção',
    ])
    expect(article.headings[0].id).toBe('o-que-e-uma-impressao-de-voz')
    expect(articlesForPage(CATALOGS['pt-BR'], 'pessoa')).toContain(article)
    expect(getArticle(CATALOGS.en, 'voice-suggestions')!.headings[0].id).toBe('what-a-voiceprint-is')
  })
})

describe('frequently asked questions', () => {
  it('each ## is a question, and the text up to the next one is the answer', () => {
    expect(parseQuestions('## Um?\n\nResposta um.\n\n## Dois?\nResposta\ndois.')).toEqual([
      { question: 'Um?', answer: 'Resposta um.' },
      { question: 'Dois?', answer: 'Resposta\ndois.' },
    ])
  })
})

const HEAD = 'title: Um artigo\ntopic: comecar\npages: [biblioteca]\nrelated: []\nterms: [a, b]\norder: 1\nupdated: 2026-09-27'
const article = (head: string, body = 'Texto.') => `---\n${head}\n---\n${body}`

describe('header reader', () => {
  it('reads values and lists, with CRLF', () => {
    expect(parseFrontmatter('---\r\ntitle: Olá: mundo\r\nterms: [a, b c]\r\nvazia: []\r\n---\r\nCorpo', 'x.md')).toEqual({
      data: { title: 'Olá: mundo', terms: ['a', 'b c'], vazia: [] },
      body: 'Corpo',
    })
  })

  it('throws with the file name', () => {
    expect(() => parseFrontmatter('no header', 'a.md')).toThrow(/^a\.md: /)
    expect(() => parseFrontmatter('---\ntitle: x\n', 'b.md')).toThrow(/b\.md: the header does not close/)
    expect(() => parseFrontmatter('---\n- item\n---\n', 'c.md')).toThrow(/c\.md: invalid header line/)
    expect(() => parseFrontmatter('---\nt: [a, b\n---\n', 'd.md')).toThrow(/d\.md: the list/)
    expect(() => parseFrontmatter('---\nt: a\nt: b\n---\n', 'e.md')).toThrow(/twice/)
  })
})

describe('article validation', () => {
  it('builds slug, headings, plain text and reading minutes', () => {
    const body = `Abertura com [link](/ajuda/outro) e **negrito**.\n\n## Primeiro passo\n\n${'palavra '.repeat(390)}`
    const parsed = parseArticle('./articles/pt-BR/um-artigo.md', article(HEAD, body))
    expect(parsed).toMatchObject({ slug: 'um-artigo', title: 'Um artigo', topic: 'comecar', order: 1 })
    expect(parsed.headings).toEqual([{ id: 'primeiro-passo', text: 'Primeiro passo' }])
    expect(parsed.plain.startsWith('Abertura com link e negrito. Primeiro passo palavra')).toBe(true)
    expect(parsed.minutes).toBe(2)
  })

  it.each([
    [HEAD.replace('topic: comecar', 'topic: outro'), /unknown topic "outro"/],
    [HEAD.replace('[biblioteca]', '[inexistente]'), /unknown page key "inexistente"/],
    [HEAD.replace('order: 1', 'order: primeiro'), /"order"/],
    [HEAD.replace('2026-09-27', '27/09/2026'), /"updated"/],
    [HEAD.replace('title: Um artigo\n', ''), /missing "title"/],
    [HEAD.replace('terms: [a, b]', 'terms: a'), /"terms" must be a bracketed list/],
    [`${HEAD}\nauthor: someone`, /unknown key "author"/],
  ])('rejects an invalid header (%#)', (head, error) => {
    expect(() => parseArticle('./articles/pt-BR/x.md', article(head))).toThrow(error)
  })

  it('sorts by topic and then by order', () => {
    const catalog = buildCatalog({
      './articles/pt-BR/b.md': article(HEAD.replace('topic: comecar', 'topic: conectar')),
      './articles/pt-BR/c.md': article(HEAD.replace('order: 1', 'order: 2')),
      './articles/pt-BR/a.md': article(HEAD.replace('order: 1', 'order: 3')),
    })
    expect(catalog.map((a) => a.slug)).toEqual(['c', 'a', 'b'])
  })

  it('the heading id strips accents and punctuation', () => {
    expect(headingId('Consentimento e remoção: o que fazer?')).toBe('consentimento-e-remocao-o-que-fazer')
  })

  it('the six topics follow the DS order', () => {
    expect([...TOPIC_KEYS]).toEqual(['comecar', 'processamento', 'transcricao', 'resumos', 'organizar', 'conectar'])
  })
})
