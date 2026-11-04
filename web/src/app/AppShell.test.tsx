import { QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Link, MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppShell, type ShellUser } from './AppShell'
import { featuredItem, groupLabel, isItemActive, itemLabel, NAV_ITEMS, navGroups, type NavGroupEntry } from './nav'
import { NotFoundPage } from './NotFoundPage'
import { PageHead } from './PageHead'
import { mockFetch } from '../test/http'
import { createQueryClient } from './queryClient'
import { setLocale } from '../i18n'

// The real queue, with "sending" controlled by the test (real converting and uploading is in ImportDialog.test).
const importState = vi.hoisted(() => ({ sending: false }))
vi.mock('../features/import/useImportQueue', async (original) => {
  const actual = await original<typeof import('../features/import/useImportQueue')>()
  return { ...actual, useImportQueue: () => ({ ...actual.useImportQueue(), sending: importState.sending }) }
})

afterEach(() => vi.unstubAllGlobals())

const member: ShellUser = { name: 'Mariana Couto', email: 'mariana@exemplo.org' }

function renderShell(user = member, onLogout = vi.fn(), at = '/tokens') {
  // The shell mounts the import queue, which uses the QueryClient.
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

describe('navigation', () => {
  const titles = (entries: NavGroupEntry[]) => entries.map((entry) => groupLabel(entry.group))
  const labels = (entries: NavGroupEntry[]) => entries.flatMap((entry) => entry.items.map(itemLabel))

  it('groups into Agente, Gravações, Organizar (data) and Regras, and the rest in the header menus', () => {
    const { main, header: more } = navGroups()
    expect(titles(main)).toEqual(['Agente', 'Gravações', 'Organizar', 'Regras'])
    expect(titles(more)).toEqual(['Minhas configurações', 'Ajuda'])
    // In NAV_ITEMS order: the owning specs enable their items without changing the order. The featured
    // item belongs to no group: the sidebar draws it before them.
    const enabled = (section: string) =>
      NAV_ITEMS.filter((i) => i.enabled && !i.featured && i.section === section).map(itemLabel)
    expect(labels(main)).toEqual(enabled('main'))
    // Import is the library's modal; the collection sits in Organizar.
    expect(labels(main)).toEqual([
      'Conversas',
      'Habilidades',
      'Biblioteca',
      'Busca',
      'Pessoas',
      'Coleções',
      'Tags',
      'Processamento automático',
      'Tipos de agenda',
      'Campos personalizados',
    ])
    expect(labels(more)).toEqual(enabled('header'))
    expect(labels(more)).toEqual(expect.arrayContaining(['Ambiente', 'Tokens de acesso', 'App desktop', 'Central de ajuda']))
  })

  it('Agente is the featured item, first in the list and outside the groups, on the /agente route', () => {
    expect(NAV_ITEMS[0]).toMatchObject({ id: 'agent', to: '/agente', featured: true, section: 'main' })
    expect(itemLabel(NAV_ITEMS[0])).toBe('Agente')
    expect(featuredItem()).toBe(NAV_ITEMS[0])
    expect(labels(navGroups().main)).not.toContain('Agente')
    expect(featuredItem(NAV_ITEMS.map((item) => ({ ...item, enabled: !item.featured })))).toBeUndefined()
  })

  it('leaves out the disabled items and the admin panel (own account and login)', () => {
    const { main, header: more } = navGroups()
    const off = NAV_ITEMS.map((item) => ({ ...item, enabled: itemLabel(item) !== 'Campos personalizados' }))
    expect(labels(Object.values(navGroups(off)).flat())).not.toContain('Campos personalizados')
    expect(labels([...main, ...more])).not.toContain('Painel admin')
  })

  it('registers each area on the route of the screen map', () => {
    const all = NAV_ITEMS.map((item) => ({ ...item, enabled: true }))
    const { main, header: more } = navGroups(all)
    expect(titles(more)).toEqual(['Minhas configurações', 'Ajuda'])
    const routes = Object.fromEntries([...main, ...more].flatMap((g) => g.items.map((i) => [itemLabel(i), i.to])))
    expect(routes).toMatchObject({
      Tags: '/tags',
      'Processamento automático': '/config/automacao',
      'Campos personalizados': '/config/campos',
      'Tipos de agenda': '/config/agendas',
      Conta: '/config/conta',
      'Ambiente': '/config/ambiente',
      'Conexão MCP': '/config/mcp',
      'App móvel': '/app-movel',
      'Central de ajuda': '/ajuda',
    })
  })

  it('lights Biblioteca on the recording page too', () => {
    const library = NAV_ITEMS.find((item) => itemLabel(item) === 'Biblioteca')!
    const people = NAV_ITEMS.find((item) => itemLabel(item) === 'Pessoas')!
    expect(isItemActive(library, '/')).toBe(true)
    expect(isItemActive(library, '/gravacoes/01928f3a')).toBe(true)
    expect(isItemActive(library, '/busca')).toBe(false)
    expect(isItemActive(people, '/pessoas/p1')).toBe(true)
    expect(isItemActive(people, '/pessoasx')).toBe(false)
  })

  it('Agente lights on a conversation, and Conversas only on the list of all of them', () => {
    const agent = NAV_ITEMS.find((item) => itemLabel(item) === 'Agente')!
    const sessions = NAV_ITEMS.find((item) => itemLabel(item) === 'Conversas')!
    expect(isItemActive(agent, '/agente')).toBe(true)
    expect(isItemActive(agent, '/agente/01928f3a')).toBe(true)
    expect(isItemActive(agent, '/agente/conversas')).toBe(false)
    expect(isItemActive(sessions, '/agente/conversas')).toBe(true)
    expect(isItemActive(sessions, '/agente/01928f3a')).toBe(false)
  })

  it('Habilidades sits in the Agente group and does not light the featured item', () => {
    const agent = NAV_ITEMS.find((item) => itemLabel(item) === 'Agente')!
    const skills = NAV_ITEMS.find((item) => itemLabel(item) === 'Habilidades')!
    expect(skills.group && groupLabel(skills.group)).toBe('Agente')
    expect(isItemActive(skills, '/agente/habilidades')).toBe(true)
    expect(isItemActive(agent, '/agente/habilidades')).toBe(false)
  })

})

describe('AppShell', () => {
  afterEach(() => document.documentElement.removeAttribute('data-theme'))

  it('follows the active locale with no remount', async () => {
    renderShell()
    expect(screen.getByRole('navigation', { name: 'Principal' })).toHaveTextContent('Biblioteca')
    await act(() => setLocale('en'))
    const nav = screen.getByRole('navigation', { name: 'Main' })
    expect(within(nav).getByRole('link', { name: 'Library' })).toBeInTheDocument()
    expect(within(nav).getByText('Recordings')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Log out' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument()
  })

  it('shows the groups in order', () => {
    renderShell()
    const nav = screen.getByRole('navigation', { name: 'Principal' })
    // The <details> also has the group role; the link groups are the ones labelled by their title.
    const titles = within(nav)
      .getAllByRole('group')
      .filter((group) => group.hasAttribute('aria-labelledby'))
      .map((group) => document.getElementById(group.getAttribute('aria-labelledby')!)!.textContent)
    // Settings and help left the sidebar: they live in the header menus.
    expect(titles).toEqual(['Agente', 'Gravações', 'Organizar', 'Regras'])
    expect(within(nav).queryByText('Configurações e ajuda')).not.toBeInTheDocument()
    for (const item of NAV_ITEMS.filter((i) => !i.enabled)) {
      expect(within(nav).queryByRole('link', { name: itemLabel(item) })).not.toBeInTheDocument()
    }
  })

  it('Agente opens the sidebar, above the groups, with an icon, and lights on its own route', () => {
    renderShell(member, vi.fn(), '/agente')
    const nav = screen.getByRole('navigation', { name: 'Principal' })
    const [first] = within(nav).getAllByRole('link')
    expect(first).toHaveAccessibleName('Agente')
    expect(first).toHaveAttribute('href', '/agente')
    expect(first).toHaveClass('btn', 'btn-primary')
    expect(first).toHaveAttribute('aria-current', 'page')
    expect(first.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    // It comes before the first group and appears inside none.
    const firstGroup = within(nav).getByRole('group', { name: 'Agente' })
    expect(first.compareDocumentPosition(firstGroup) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(firstGroup).queryByRole('link', { name: 'Agente' })).not.toBeInTheDocument()
    expect(within(firstGroup).getByRole('link', { name: 'Conversas' })).toHaveAttribute('href', '/agente/conversas')
    expect(within(firstGroup).getByRole('link', { name: 'Habilidades' })).toHaveAttribute('href', '/agente/habilidades')
    expect(within(nav).queryByRole('link', { name: 'Perguntar' })).not.toBeInTheDocument()
  })

  it('Agente loses its emphasis, not its place, while the account has no recording', async () => {
    mockFetch({ 'GET /api/v1/recordings': () => ({ items: [], next_cursor: null }) })
    renderShell(member, vi.fn(), '/pessoas')
    const nav = screen.getByRole('navigation', { name: 'Principal' })
    const [first] = within(nav).getAllByRole('link')
    expect(first).toHaveAccessibleName('Agente')
    await waitFor(() => expect(first).toHaveClass('btn', 'btn-secondary'))
    expect(first).not.toHaveClass('btn-primary')
  })

  it('Agente does not light outside the /agente route', () => {
    renderShell(member, vi.fn(), '/pessoas')
    const nav = screen.getByRole('navigation', { name: 'Principal' })
    expect(within(nav).getByRole('link', { name: 'Agente' })).not.toHaveAttribute('aria-current')
  })

  it('does not show the admin panel', () => {
    renderShell()
    expect(screen.queryByRole('link', { name: 'Painel admin' })).not.toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Gravações' })).toBeInTheDocument()
  })

  it('marks the current page, has a skip link, shows the user in the header and logs out', async () => {
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

  it('with an upload in progress, Sair asks for confirmation before ending the session', async () => {
    importState.sending = true
    try {
      const onLogout = renderShell()
      const header = screen.getByRole('banner')
      await userEvent.click(within(header).getByRole('button', { name: 'Sair' }))
      const dialog = await screen.findByRole('dialog', { name: 'Sair durante o envio?' })
      expect(dialog).toHaveTextContent('O envio em andamento será interrompido.')
      await userEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }))
      expect(onLogout).not.toHaveBeenCalled()

      await userEvent.click(within(header).getByRole('button', { name: 'Sair' }))
      const again = await screen.findByRole('dialog', { name: 'Sair durante o envio?' })
      await userEvent.click(within(again).getByRole('button', { name: 'Sair' }))
      expect(onLogout).toHaveBeenCalled()
    } finally {
      importState.sending = false
    }
  })

  it('on a recording, Biblioteca stays marked as in the frame', () => {
    renderShell(member, vi.fn(), '/gravacoes/01928f3a-1c00-7a00-8000-000000000401')
    const nav = screen.getByRole('navigation', { name: 'Principal' })
    expect(within(nav).getByRole('link', { name: 'Biblioteca' })).toHaveAttribute('aria-current', 'page')
  })

  it('the gear opens Minhas configurações and navigates without touching the sidebar', async () => {
    renderShell(member, vi.fn(), '/pessoas')
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Configurações' }))
    const menu = screen.getByRole('menu', { name: 'Minhas configurações' })
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Conta',
      'App desktop',
      'App móvel',
      'Conexão MCP',
      'Tokens de acesso',
      'Ambiente',
    ])
    // Grouped by nature: each part opens with a label the keyboard does not focus.
    expect(within(menu).getAllByRole('separator').map((sep) => sep.getAttribute('aria-label'))).toEqual([
      'Conta e privacidade',
      'Aparelhos',
      'Integrações',
      'Ambiente',
    ])
    await user.keyboard('{ArrowDown}')
    expect(within(menu).getByRole('menuitem', { name: 'App desktop' })).toHaveFocus()
    await user.click(within(menu).getByRole('menuitem', { name: 'Tokens de acesso' }))
    expect(await screen.findByRole('heading', { name: 'Tokens' })).toBeInTheDocument()
    const nav = screen.getByRole('navigation', { name: 'Principal' })
    expect(within(nav).queryByRole('link', { name: 'Tokens de acesso' })).not.toBeInTheDocument()
    expect(within(nav).queryByRole('link', { current: 'page' })).not.toBeInTheDocument()
  })

  it('the help button opens the page help or goes to the help center', async () => {
    renderShell()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Ajuda' }))
    const menu = screen.getByRole('menu', { name: 'Ajuda' })
    expect(within(menu).getByRole('menuitem', { name: /Central de ajuda/ })).toBeInTheDocument()
    await user.click(within(menu).getByRole('menuitem', { name: /Ajuda desta página/ }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })

  it('opens and closes the compact menu', async () => {
    renderShell()
    const button = screen.getByRole('button', { name: 'Menu' })
    expect(button).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'true')
    await userEvent.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'false')
  })
})

describe('accessible compact menu', () => {
  it('opening focuses the first link, Esc closes and returns focus to Menu, and the current route link closes', async () => {
    const user = userEvent.setup()
    renderShell(member, vi.fn(), '/pessoas')
    const button = screen.getByRole('button', { name: 'Menu' })
    await user.click(button)
    const sidebar = document.getElementById(button.getAttribute('aria-controls')!)!
    expect(sidebar.querySelector('a[href]')).toHaveFocus()

    await user.keyboard('{Escape}')
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(button).toHaveFocus()

    await user.click(button)
    const nav = screen.getByRole('navigation', { name: 'Principal' })
    await user.click(within(nav).getByRole('link', { name: 'Pessoas' }))
    expect(button).toHaveAttribute('aria-expanded', 'false')
  })
})

describe('PageHead and 404', () => {
  it('shows kicker, title and actions, and sets the tab title', () => {
    render(<PageHead kicker="Organizar" title="Pessoas" actions={<button type="button">Adicionar</button>} />)
    expect(screen.getByRole('heading', { level: 1, name: 'Pessoas' })).toBeInTheDocument()
    expect(screen.getByText('Organizar')).toHaveClass('kicker')
    expect(screen.getByRole('button', { name: 'Adicionar' })).toBeInTheDocument()
    expect(document.title).toBe('Pessoas · eclume')
  })

  it('an unknown route shows the not-found page inside the shell', () => {
    renderShell(member, vi.fn(), '/nao-existe')
    const main = screen.getByRole('main')
    expect(within(main).getByRole('heading', { level: 1, name: 'Página não encontrada' })).toBeInTheDocument()
    expect(within(main).getByRole('link', { name: 'Voltar à biblioteca' })).toHaveAttribute('href', '/')
    expect(screen.getByRole('navigation', { name: 'Principal' })).toBeInTheDocument()
  })
})

describe('focus on route change', () => {
  function renderPages() {
    render(
      <QueryClientProvider client={createQueryClient({ retry: false })}>
        <MemoryRouter initialEntries={['/tokens']}>
          <Routes>
            <Route element={<AppShell user={member} onLogout={vi.fn()} />}>
              <Route path="/tokens" element={<PageHead title="Tokens" />} />
              <Route
                path="/pessoas"
                element={
                  <PageHead title="Pessoas" actions={<Link to="?aba=falas">Falas</Link>} />
                }
              />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )
  }

  it('does not move focus on first load, focuses the new page h1 and does not move on a search-only change', async () => {
    renderPages()
    expect(screen.getByRole('heading', { level: 1, name: 'Tokens' })).not.toHaveFocus()

    const nav = screen.getByRole('navigation', { name: 'Principal' })
    await userEvent.click(within(nav).getByRole('link', { name: 'Pessoas' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Pessoas' })).toHaveFocus()

    const speechTab = screen.getByRole('link', { name: 'Falas' })
    await userEvent.click(speechTab)
    expect(screen.getByRole('heading', { level: 1, name: 'Pessoas' })).not.toHaveFocus()
  })
})
