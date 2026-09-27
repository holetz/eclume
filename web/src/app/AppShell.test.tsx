import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppShell, type ShellUser } from './AppShell'
import { isInMoreSection, NAV_ITEMS, navGroups } from './nav'

const member: ShellUser = { name: 'Mariana Couto', email: 'mariana@exemplo.org', role: 'member' }

function renderShell(user = member, onLogout = vi.fn()) {
  render(
    <MemoryRouter initialEntries={['/tokens']}>
      <Routes>
        <Route element={<AppShell user={user} onLogout={onLogout} />}>
          <Route path="/tokens" element={<h1>Tokens</h1>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
  return onLogout
}

describe('navegação', () => {
  const titles = (entries: { group: string }[]) => entries.map((entry) => entry.group)
  const labels = (entries: { items: { label: string }[] }[]) => entries.flatMap((entry) => entry.items.map((i) => i.label))

  it('agrupa em Gravações, Organizar e Administração, e o resto em Configurações e ajuda', () => {
    const { main, more } = navGroups('admin')
    expect(titles(main)).toEqual(['Gravações', 'Organizar', 'Administração'])
    expect(titles(more)).toEqual(['Minhas configurações'])
    expect(labels(main)).toEqual(['Biblioteca', 'Busca', 'Importar arquivo', 'Pessoas', 'Coleções', 'Painel admin'])
    expect(labels(more)).toEqual(['Tokens de acesso', 'App desktop'])
  })

  it('deixa fora os itens desligados e o admin para quem não é admin', () => {
    const { main, more } = navGroups('member')
    expect(titles(main)).toEqual(['Gravações', 'Organizar'])
    expect(labels([...main, ...more])).not.toContain('Campos e regras')
    expect(labels([...main, ...more])).not.toContain('Central de ajuda')
    expect(labels(main)).not.toContain('Painel admin')
  })

  it('liga as áreas futuras nas rotas do mapa de telas', () => {
    const all = NAV_ITEMS.map((item) => ({ ...item, enabled: true }))
    const { main, more } = navGroups('member', all)
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

  it('marca a página corrente, tem skip link e sai', async () => {
    const onLogout = renderShell()
    const nav = screen.getByRole('navigation', { name: 'Principal' })
    expect(within(nav).getByRole('link', { name: 'Tokens de acesso' })).toHaveAttribute('aria-current', 'page')
    expect(within(nav).getByRole('link', { name: 'Biblioteca' })).not.toHaveAttribute('aria-current')
    expect(screen.getByRole('link', { name: 'Pular para o conteúdo' })).toHaveAttribute('href', '#conteudo')
    expect(screen.getByText('Mariana Couto')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Sair' }))
    expect(onLogout).toHaveBeenCalled()
  })

  it('troca o tema e lembra a escolha', async () => {
    renderShell()
    await userEvent.selectOptions(screen.getByLabelText('Tema'), 'dark')
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    expect(localStorage.getItem('eclume-tema')).toBe('dark')
    await userEvent.selectOptions(screen.getByLabelText('Tema'), 'system')
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    expect(localStorage.getItem('eclume-tema')).toBeNull()
  })

  it('abre e fecha o menu compacto', async () => {
    renderShell()
    const button = screen.getByRole('button', { name: 'Menu' })
    expect(button).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'true')
  })
})
