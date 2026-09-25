import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppShell, type ShellUser } from './AppShell'
import { NAV_ITEMS, navGroups } from './nav'

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
  it('mostra só as áreas ligadas, e o admin só para admin', () => {
    const items = NAV_ITEMS.map((i) => (i.adminOnly ? { ...i, enabled: true } : i))
    const labels = (role: 'admin' | 'member') =>
      navGroups(role, items).flatMap((g) => g.items.map((i) => i.label))
    expect(labels('member')).toContain('Pessoas')
    expect(labels('member')).not.toContain('Painel admin')
    expect(labels('admin')).toContain('Painel admin')
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
    expect(document.documentElement).not.toHaveAttribute('data-theme')
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
