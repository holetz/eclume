import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { fixtures } from '../../test/fixtures'
import { mockFetch } from '../../test/http'
import { preloadRoute, renderApp } from '../../test/render'
import { articlesByTopic, TOPICS } from './catalog'

beforeAll(() => preloadRoute('/pessoas'))

afterEach(() => vi.unstubAllGlobals())

function openHelp(path: string) {
  mockFetch({ 'GET /api/v1/me': () => fixtures.me() })
  return renderApp(path)
}

describe('central de ajuda', () => {
  it('mostra os seis tópicos com três artigos, o total e as perguntas frequentes', async () => {
    openHelp('/ajuda')
    expect(await screen.findByRole('heading', { level: 1, name: 'Central de ajuda' })).toBeInTheDocument()
    for (const topic of TOPICS) {
      const card = screen.getByRole('region', { name: topic.title })
      expect(within(card).getByText(topic.kicker)).toBeInTheDocument()
      const links = within(card).getAllByRole('link')
      const total = articlesByTopic(topic.key).length
      expect(links).toHaveLength(4)
      expect(links[3]).toHaveTextContent(`Todos os ${total} artigos →`)
      expect(links[3]).toHaveAttribute('href', `/ajuda?topico=${topic.key}`)
    }
    const faq = screen.getByRole('region', { name: 'Perguntas frequentes' })
    const details = faq.querySelectorAll('details')
    expect(details).toHaveLength(6)
    expect(details[0]).toHaveAttribute('open')
    expect(details[1]).not.toHaveAttribute('open')
    expect(within(faq).getByText('Quem vê minhas gravações?')).toBeInTheDocument()
    expect(screen.getByText('Ainda com dúvida? Fale com quem administra este servidor.')).toBeInTheDocument()
    // A central está ligada na navegação.
    // A central mora no menu de ajuda do cabeçalho; a barra lateral não acende nada.
    const nav = screen.getByRole('navigation', { name: 'Principal' })
    expect(within(nav).queryByRole('link', { current: 'page' })).not.toBeInTheDocument()
  })

  it('lista um tópico inteiro por ?topico=', async () => {
    openHelp('/ajuda?topico=organizar')
    const list = await screen.findByRole('list', { name: 'Campos, regras e tipos de agenda' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(articlesByTopic('organizar').length)
    expect(screen.getByRole('link', { name: '← Todos os tópicos' })).toHaveAttribute('href', '/ajuda')
  })

  it('busca sem acento, guarda a consulta em ?q= e marca o termo no trecho', async () => {
    openHelp('/ajuda')
    const search = await screen.findByRole('searchbox', { name: 'Buscar na ajuda' })
    await userEvent.type(search, 'impressao de voz')
    const results = await screen.findByRole('list', { name: 'Resultados da busca' })
    expect(within(results).getAllByRole('link')[0]).toHaveTextContent(/voz/i)
    expect(within(results).getByRole('link', { name: 'Como funcionam as sugestões por voz' })).toHaveAttribute(
      'href',
      '/ajuda/sugestoes-por-voz',
    )
    expect(results.querySelector('mark')).toHaveTextContent(/impressão|voz/i)
    expect(screen.queryByRole('region', { name: 'Perguntas frequentes' })).not.toBeInTheDocument()
  })

  it('diz quando nada foi encontrado', async () => {
    openHelp('/ajuda?q=girafa')
    expect(await screen.findByText(/Nada encontrado para “girafa”/)).toBeInTheDocument()
  })

  it('/ fora de um campo põe o foco na busca', async () => {
    openHelp('/ajuda')
    const search = await screen.findByRole('searchbox', { name: 'Buscar na ajuda' })
    await userEvent.keyboard('/')
    expect(search).toHaveFocus()
    expect(search).toHaveValue('')
  })
})

describe('artigo da ajuda', () => {
  it('mostra trilha, meta, corpo com alerta, índice e relacionados', async () => {
    openHelp('/ajuda/sugestoes-por-voz')
    expect(await screen.findByRole('heading', { level: 1, name: 'Como funcionam as sugestões por voz' })).toBeInTheDocument()
    const crumbs = screen.getByRole('link', { name: 'Transcrição e locutores' })
    expect(crumbs).toHaveAttribute('href', '/ajuda?topico=transcricao')
    expect(screen.getByText('Atualizado em 30/09/2026')).toBeInTheDocument()
    expect(screen.getByText(/min de leitura$/)).toBeInTheDocument()

    const heading = screen.getByRole('heading', { level: 2, name: 'O que é uma impressão de voz' })
    expect(heading).toHaveAttribute('id', 'o-que-e-uma-impressao-de-voz')
    const alert = screen.getByRole('note')
    expect(alert).toHaveClass('alert', 'alert-info')
    expect(within(alert).getByText('Desligada por padrão')).toHaveClass('alert-title')
    expect(alert).toHaveTextContent(/Quem administra o servidor precisa ligar/)

    const toc = screen.getByRole('navigation', { name: 'Nesta página' })
    const entries = within(toc).getAllByRole('link')
    expect(entries.map((a) => a.getAttribute('href'))).toEqual([
      '#o-que-e-uma-impressao-de-voz',
      '#quando-o-eclume-sugere-uma-pessoa',
      '#atribuicao-automatica',
      '#consentimento-e-remocao',
    ])
    expect(entries[0]).toHaveAttribute('aria-current', 'true')

    const related = screen.getByRole('navigation', { name: 'Relacionados' })
    await userEvent.click(within(related).getByRole('link', { name: 'Apague a impressão de voz de uma pessoa' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Apague a impressão de voz de uma pessoa' })).toBeInTheDocument()
  })

  it('um link para /downloads/ é um link comum', async () => {
    openHelp('/ajuda/certificado-do-servidor')
    const download = await screen.findByRole('link', { name: '/downloads/eclume-root.crt' })
    expect(download).toHaveAttribute('href', '/downloads/eclume-root.crt')
    const next = screen.getByRole('link', { name: 'a próxima raiz' })
    expect(next).toHaveAttribute('href', '/downloads/eclume-root-proxima.crt')
  })

  it('um link para outro artigo navega sem recarregar', async () => {
    openHelp('/ajuda/conectar-assistente-mcp')
    const body = await screen.findByRole('article')
    await userEvent.click(within(body).getByRole('link', { name: 'Crie um token de acesso' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Crie um token de acesso' })).toBeInTheDocument()
  })

  it('slug desconhecido mostra "Artigo não encontrado"', async () => {
    openHelp('/ajuda/nao-existe')
    expect(await screen.findByRole('heading', { level: 1, name: 'Artigo não encontrado' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'central de ajuda' })).toHaveAttribute('href', '/ajuda')
  })
})

describe('ajuda nas páginas', () => {
  it('? na página de Pessoas abre a gaveta com os artigos dela, e a dica leva ao artigo', async () => {
    mockFetch({
      'GET /api/v1/me': () => fixtures.me(),
      'GET /api/v1/people': () => fixtures.personPage(),
    })
    renderApp('/pessoas')
    await screen.findByRole('heading', { level: 1, name: 'Pessoas' })
    await userEvent.click(screen.getByRole('button', { name: 'Sobre as sugestões por voz' }))
    const popover = screen.getByRole('dialog', { name: 'Sugestões por voz' })
    expect(within(popover).getByRole('link', { name: 'Ler o artigo →' })).toHaveAttribute('href', '/ajuda/sugestoes-por-voz')
    await userEvent.keyboard('{Escape}')

    await userEvent.keyboard('?')
    const drawer = screen.getByRole('dialog', { name: 'Ajuda' })
    expect(await within(drawer).findByText('Nesta página · Pessoas')).toBeInTheDocument()
    await userEvent.click(within(drawer).getByRole('link', { name: 'Ligue um locutor a uma pessoa' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Ligue um locutor a uma pessoa' })).toBeInTheDocument()
    expect(within(drawer).getByText('Nesta página · Central de ajuda')).toBeInTheDocument()
  })
})
