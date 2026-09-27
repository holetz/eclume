import { QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppShell, type ShellUser } from './AppShell'
import { isInMoreSection, isItemActive, NAV_ITEMS, navGroups } from './nav'
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

const more = () => screen.getByText('Configurações e ajuda').closest('details')!

describe('navegação', () => {
  const titles = (entries: { group: string }[]) => entries.map((entry) => entry.group)
  const labels = (entries: { items: { label: string }[] }[]) => entries.flatMap((entry) => entry.items.map((i) => i.label))

  it('agrupa em Gravações e Organizar, e o resto em Configurações e ajuda', () => {
    const { main, more } = navGroups()
    expect(titles(main)).toEqual(['Gravações', 'Organizar'])
    expect(titles(more)).toEqual(['Minhas configurações', 'Ajuda'])
    // Na ordem do NAV_ITEMS: as specs donas ligam os itens delas sem mudar a ordem.
    const enabled = (section: string) => NAV_ITEMS.filter((i) => i.enabled && i.section === section).map((i) => i.label)
    expect(labels(main)).toEqual(enabled('main'))
    // Importar é o modal da biblioteca; a coleção fica em Organizar.
    expect(labels(main).slice(0, 5)).toEqual(['Biblioteca', 'Busca', 'Pessoas', 'Coleções', 'Campos e regras'])
    expect(labels(more)).toEqual(enabled('more'))
    expect(labels(more)).toEqual(expect.arrayContaining(['Tokens de acesso', 'App desktop', 'Central de ajuda']))
  })

  it('deixa fora os itens desligados e o painel admin (conta e login próprios)', () => {
    const { main, more } = navGroups()
    const off = NAV_ITEMS.map((item) => ({ ...item, enabled: item.label !== 'Campos e regras' }))
    expect(labels(Object.values(navGroups(off)).flat())).not.toContain('Campos e regras')
    expect(labels([...main, ...more])).not.toContain('Painel admin')
  })

  it('liga as áreas futuras nas rotas do mapa de telas', () => {
    const all = NAV_ITEMS.map((item) => ({ ...item, enabled: true }))
    const { main, more } = navGroups(all)
    expect(titles(more)).toEqual(['Minhas configurações', 'Ajuda'])
    const routes = Object.fromEntries([...main, ...more].flatMap((g) => g.items.map((i) => [i.label, i.to])))
    expect(routes).toMatchObject({
      'Campos e regras': '/config/campos',
      'Tipos de agenda': '/config/agendas',
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

  it('reconhece as rotas da seção recolhível', () => {
    expect(isInMoreSection('/tokens')).toBe(true)
    expect(isInMoreSection('/app-desktop')).toBe(true)
    expect(isInMoreSection('/ajuda/criar-token')).toBe(true)
    expect(isInMoreSection('/pessoas')).toBe(false)
    expect(isInMoreSection('/')).toBe(false)
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
    expect(titles).toEqual(['Gravações', 'Organizar', 'Minhas configurações', 'Ajuda'])
    expect(within(nav).getByText('Configurações e ajuda').tagName).toBe('SUMMARY')
    for (const item of NAV_ITEMS.filter((i) => !i.enabled)) {
      expect(within(nav).queryByRole('link', { name: item.label })).not.toBeInTheDocument()
    }
  })

  it('não mostra o painel admin', () => {
    renderShell()
    expect(screen.queryByRole('link', { name: 'Painel admin' })).not.toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Gravações' })).toBeInTheDocument()
  })

  it('marca a página corrente, tem skip link, mostra o usuário e sai', async () => {
    const onLogout = renderShell()
    const nav = screen.getByRole('navigation', { name: 'Principal' })
    expect(within(nav).getByRole('link', { name: 'Tokens de acesso' })).toHaveAttribute('aria-current', 'page')
    expect(within(nav).getByRole('link', { name: 'Biblioteca' })).not.toHaveAttribute('aria-current')
    expect(within(nav).queryByRole('link', { name: 'Importar arquivo' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Pular para o conteúdo' })).toHaveAttribute('href', '#conteudo')
    expect(screen.getByText('Mariana Couto')).toBeInTheDocument()
    expect(screen.getByText('mariana@exemplo.org')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Sair' }))
    expect(onLogout).toHaveBeenCalled()
  })

  it('na gravação, a Biblioteca fica marcada como no frame', () => {
    renderShell(member, vi.fn(), '/gravacoes/01928f3a-1c00-7a00-8000-000000000401')
    const nav = screen.getByRole('navigation', { name: 'Principal' })
    expect(within(nav).getByRole('link', { name: 'Biblioteca' })).toHaveAttribute('aria-current', 'page')
  })

  it('abre "Configurações e ajuda" sozinha quando a rota está nela', () => {
    renderShell(member, vi.fn(), '/tokens')
    expect(more()).toHaveAttribute('open')
  })

  it('deixa "Configurações e ajuda" fechada fora dela e abre pelo resumo', async () => {
    renderShell(member, vi.fn(), '/pessoas')
    expect(more()).not.toHaveAttribute('open')
    await userEvent.click(screen.getByText('Configurações e ajuda'))
    expect(more()).toHaveAttribute('open')
  })

  it('troca o tema pelo controle segmentado e lembra a escolha', async () => {
    renderShell()
    const theme = screen.getByRole('radiogroup', { name: 'Tema' })
    await userEvent.click(within(theme).getByRole('radio', { name: 'Escuro' }))
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    expect(localStorage.getItem('eclume-tema')).toBe('dark')
    await userEvent.click(within(theme).getByRole('radio', { name: 'Sistema' }))
    expect(within(theme).getByRole('radio', { name: 'Sistema' })).toBeChecked()
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    expect(localStorage.getItem('eclume-tema')).toBeNull()
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
