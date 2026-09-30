import { QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppShell, type ShellUser } from './AppShell'
import { featuredItem, isItemActive, NAV_ITEMS, navGroups } from './nav'
import { NotFoundPage } from './NotFoundPage'
import { PageHead } from './PageHead'
import { createQueryClient } from './queryClient'

const member: ShellUser = { name: 'Mariana Couto', email: 'mariana@exemplo.org' }

function renderShell(user = member, onLogout = vi.fn(), at = '/tokens') {
  // O shell monta a fila de importação, que usa o QueryClient.
  render(
    <QueryClientProvider client={createQueryClient({ retry: false })}>
      <MemoryRouter initialEntries={[at]}>
        <Routes>
          <Route element={<AppShell user={user} onLogout={onLogout} />}>
            <Route path="/tokens" element={<h1>Tokens</h1>} />
            <Route path="/pessoas" element={<h1>Pessoas</h1>} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return onLogout
}

describe('navegação', () => {
  const titles = (entries: { group: string }[]) => entries.map((entry) => entry.group)
  const labels = (entries: { items: { label: string }[] }[]) => entries.flatMap((entry) => entry.items.map((i) => i.label))

  it('agrupa em Gravações e Organizar, e o resto nos menus do cabeçalho', () => {
    const { main, header: more } = navGroups()
    expect(titles(main)).toEqual(['Gravações', 'Organizar'])
    expect(titles(more)).toEqual(['Minhas configurações', 'Ajuda'])
    // Na ordem do NAV_ITEMS: as specs donas ligam os itens delas sem mudar a ordem. O destacado não
    // pertence a grupo: a barra lateral o desenha antes deles.
    const enabled = (section: string) =>
      NAV_ITEMS.filter((i) => i.enabled && !i.featured && i.section === section).map((i) => i.label)
    expect(labels(main)).toEqual(enabled('main'))
    // Importar é o modal da biblioteca; a coleção fica em Organizar.
    expect(labels(main).slice(0, 5)).toEqual(['Biblioteca', 'Busca', 'Pessoas', 'Coleções', 'Campos e regras'])
    expect(labels(more)).toEqual(enabled('header'))
    expect(labels(more)).toEqual(expect.arrayContaining(['Ambiente', 'Tokens de acesso', 'App desktop', 'Central de ajuda']))
  })

  it('Perguntar é o item destacado, primeiro da lista e fora dos grupos, e segue na rota /perguntas', () => {
    expect(NAV_ITEMS[0]).toMatchObject({ to: '/perguntas', label: 'Perguntar', featured: true, section: 'main' })
    expect(featuredItem()).toBe(NAV_ITEMS[0])
    expect(labels(navGroups().main)).not.toContain('Perguntar')
    expect(featuredItem(NAV_ITEMS.map((item) => ({ ...item, enabled: !item.featured })))).toBeUndefined()
  })

  it('deixa fora os itens desligados e o painel admin (conta e login próprios)', () => {
    const { main, header: more } = navGroups()
    const off = NAV_ITEMS.map((item) => ({ ...item, enabled: item.label !== 'Campos e regras' }))
    expect(labels(Object.values(navGroups(off)).flat())).not.toContain('Campos e regras')
    expect(labels([...main, ...more])).not.toContain('Painel admin')
  })

  it('registra cada área na rota do mapa de telas', () => {
    const all = NAV_ITEMS.map((item) => ({ ...item, enabled: true }))
    const { main, header: more } = navGroups(all)
    expect(titles(more)).toEqual(['Minhas configurações', 'Ajuda'])
    const routes = Object.fromEntries([...main, ...more].flatMap((g) => g.items.map((i) => [i.label, i.to])))
    expect(routes).toMatchObject({
      'Campos e regras': '/config/campos',
      'Tipos de agenda': '/config/agendas',
      'Ambiente': '/config/ambiente',
      'Conexão MCP': '/config/mcp',
      'App móvel': '/app-movel',
      'Central de ajuda': '/ajuda',
    })
  })

  it('acende a Biblioteca também na página da gravação', () => {
    const library = NAV_ITEMS.find((item) => item.label === 'Biblioteca')!
    const people = NAV_ITEMS.find((item) => item.label === 'Pessoas')!
    expect(isItemActive(library, '/')).toBe(true)
    expect(isItemActive(library, '/gravacoes/01928f3a')).toBe(true)
    expect(isItemActive(library, '/busca')).toBe(false)
    expect(isItemActive(people, '/pessoas/p1')).toBe(true)
    expect(isItemActive(people, '/pessoasx')).toBe(false)
  })

})

describe('AppShell', () => {
  afterEach(() => document.documentElement.removeAttribute('data-theme'))

  it('mostra os grupos na ordem', () => {
    renderShell()
    const nav = screen.getByRole('navigation', { name: 'Principal' })
    // O <details> também tem o papel group; os grupos de links são os rotulados pelo título.
    const titles = within(nav)
      .getAllByRole('group')
      .filter((group) => group.hasAttribute('aria-labelledby'))
      .map((group) => document.getElementById(group.getAttribute('aria-labelledby')!)!.textContent)
    // Configurações e ajuda saíram da barra lateral: moram nos menus do cabeçalho.
    expect(titles).toEqual(['Gravações', 'Organizar'])
    expect(within(nav).queryByText('Configurações e ajuda')).not.toBeInTheDocument()
    for (const item of NAV_ITEMS.filter((i) => !i.enabled)) {
      expect(within(nav).queryByRole('link', { name: item.label })).not.toBeInTheDocument()
    }
  })

  it('Perguntar abre a barra lateral, acima dos grupos, com ícone, e acende na própria rota', () => {
    renderShell(member, vi.fn(), '/perguntas')
    const nav = screen.getByRole('navigation', { name: 'Principal' })
    const [first] = within(nav).getAllByRole('link')
    expect(first).toHaveAccessibleName('Perguntar')
    expect(first).toHaveAttribute('href', '/perguntas')
    expect(first).toHaveClass('btn', 'btn-primary')
    expect(first).toHaveAttribute('aria-current', 'page')
    expect(first.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    // Vem antes do primeiro grupo e não aparece dentro de nenhum.
    const firstGroup = within(nav).getByRole('group', { name: 'Gravações' })
    expect(first.compareDocumentPosition(firstGroup) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(firstGroup).queryByRole('link', { name: 'Perguntar' })).not.toBeInTheDocument()
    expect(within(nav).queryByRole('link', { name: 'Perguntas' })).not.toBeInTheDocument()
  })

  it('Perguntar não acende fora da rota /perguntas', () => {
    renderShell(member, vi.fn(), '/pessoas')
    const nav = screen.getByRole('navigation', { name: 'Principal' })
    expect(within(nav).getByRole('link', { name: 'Perguntar' })).not.toHaveAttribute('aria-current')
  })

  it('não mostra o painel admin', () => {
    renderShell()
    expect(screen.queryByRole('link', { name: 'Painel admin' })).not.toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Gravações' })).toBeInTheDocument()
  })

  it('marca a página corrente, tem skip link, mostra o usuário no cabeçalho e sai', async () => {
    const onLogout = renderShell(member, vi.fn(), '/pessoas')
    const nav = screen.getByRole('navigation', { name: 'Principal' })
    expect(within(nav).getByRole('link', { name: 'Pessoas' })).toHaveAttribute('aria-current', 'page')
    expect(within(nav).getByRole('link', { name: 'Biblioteca' })).not.toHaveAttribute('aria-current')
    expect(within(nav).queryByRole('link', { name: 'Importar arquivo' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Pular para o conteúdo' })).toHaveAttribute('href', '#conteudo')
    const header = screen.getByRole('banner')
    expect(within(header).getByRole('link', { name: 'eclume' })).toHaveAttribute('href', '/')
    expect(within(header).getByText('Mariana Couto')).toBeInTheDocument()
    expect(within(header).getByText('mariana@exemplo.org')).toBeInTheDocument()
    await userEvent.click(within(header).getByRole('button', { name: 'Sair' }))
    expect(onLogout).toHaveBeenCalled()
  })

  it('na gravação, a Biblioteca fica marcada como no frame', () => {
    renderShell(member, vi.fn(), '/gravacoes/01928f3a-1c00-7a00-8000-000000000401')
    const nav = screen.getByRole('navigation', { name: 'Principal' })
    expect(within(nav).getByRole('link', { name: 'Biblioteca' })).toHaveAttribute('aria-current', 'page')
  })

  it('a engrenagem abre Minhas configurações e navega sem mexer na barra lateral', async () => {
    renderShell(member, vi.fn(), '/pessoas')
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Configurações' }))
    const menu = screen.getByRole('menu', { name: 'Minhas configurações' })
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Ambiente',
      'Conexão MCP',
      'Tokens de acesso',
      'App desktop',
      'App móvel',
    ])
    await user.click(within(menu).getByRole('menuitem', { name: 'Tokens de acesso' }))
    expect(await screen.findByRole('heading', { name: 'Tokens' })).toBeInTheDocument()
    const nav = screen.getByRole('navigation', { name: 'Principal' })
    expect(within(nav).queryByRole('link', { name: 'Tokens de acesso' })).not.toBeInTheDocument()
    expect(within(nav).queryByRole('link', { current: 'page' })).not.toBeInTheDocument()
  })

  it('o botão de ajuda abre a ajuda da página ou leva à central', async () => {
    renderShell()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Ajuda' }))
    const menu = screen.getByRole('menu', { name: 'Ajuda' })
    expect(within(menu).getByRole('menuitem', { name: /Central de ajuda/ })).toBeInTheDocument()
    await user.click(within(menu).getByRole('menuitem', { name: /Ajuda desta página/ }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })

  it('abre e fecha o menu compacto', async () => {
    renderShell()
    const button = screen.getByRole('button', { name: 'Menu' })
    expect(button).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'true')
    await userEvent.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'false')
  })
})

describe('PageHead e 404', () => {
  it('mostra kicker, título e ações, e dá o título da aba', () => {
    render(<PageHead kicker="Organizar" title="Pessoas" actions={<button type="button">Adicionar</button>} />)
    expect(screen.getByRole('heading', { level: 1, name: 'Pessoas' })).toBeInTheDocument()
    expect(screen.getByText('Organizar')).toHaveClass('kicker')
    expect(screen.getByRole('button', { name: 'Adicionar' })).toBeInTheDocument()
    expect(document.title).toBe('Pessoas · eclume')
  })

  it('uma rota inexistente mostra a página não encontrada dentro do shell', () => {
    renderShell(member, vi.fn(), '/nao-existe')
    const main = screen.getByRole('main')
    expect(within(main).getByRole('heading', { level: 1, name: 'Página não encontrada' })).toBeInTheDocument()
    expect(within(main).getByRole('link', { name: 'Voltar à biblioteca' })).toHaveAttribute('href', '/')
    expect(screen.getByRole('navigation', { name: 'Principal' })).toBeInTheDocument()
  })
})
