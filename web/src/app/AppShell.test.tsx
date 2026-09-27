import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppShell, type ShellUser } from './AppShell'
import { isInMoreSection, NAV_ITEMS, navGroups } from './nav'
import { NotFoundPage } from './NotFoundPage'
import { PageHead } from './PageHead'

const member: ShellUser = { name: 'Mariana Couto', email: 'mariana@exemplo.org' }

function renderShell(user = member, onLogout = vi.fn(), at = '/tokens') {
  render(
    <MemoryRouter initialEntries={[at]}>
      <Routes>
        <Route element={<AppShell user={user} onLogout={onLogout} />}>
          <Route path="/tokens" element={<h1>Tokens</h1>} />
          <Route path="/pessoas" element={<h1>Pessoas</h1>} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </MemoryRouter>,
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
    expect(titles(more)).toEqual(['Minhas configurações'])
    expect(labels(main)).toEqual(['Biblioteca', 'Busca', 'Importar arquivo', 'Pessoas', 'Coleções'])
    expect(labels(more)).toEqual(['Tokens de acesso', 'App desktop'])
  })

  it('deixa fora os itens desligados e o painel admin (conta e login próprios)', () => {
    const { main, more } = navGroups()
    expect(labels([...main, ...more])).not.toContain('Campos e regras')
    expect(labels([...main, ...more])).not.toContain('Central de ajuda')
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

  it('reconhece as rotas da seção recolhível', () => {
    expect(isInMoreSection('/tokens')).toBe(true)
    expect(isInMoreSection('/app-desktop')).toBe(true)
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
    expect(titles).toEqual(['Gravações', 'Organizar', 'Minhas configurações'])
    expect(within(nav).getByText('Configurações e ajuda').tagName).toBe('SUMMARY')
    expect(within(nav).queryByRole('link', { name: 'Campos e regras' })).not.toBeInTheDocument()
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
    expect(screen.getByRole('link', { name: 'Pular para o conteúdo' })).toHaveAttribute('href', '#conteudo')
    expect(screen.getByText('Mariana Couto')).toBeInTheDocument()
    expect(screen.getByText('mariana@exemplo.org')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Sair' }))
    expect(onLogout).toHaveBeenCalled()
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
