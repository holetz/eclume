import { useId } from 'react'
import { Link, Outlet, useLocation, useNavigate } from 'react-router'
import { CircleHelp, LogOut, Settings } from 'lucide-react'
import styles from './AppShell.module.css'
import { Brand } from './Brand'
import { ConnectionBanner } from './ConnectionBanner'
import { ImportProvider } from '../features/import/ImportProvider'
import { useHelp } from './help'
import { HelpProvider } from './HelpProvider'
import { MenuButton, type MenuEntry } from './MenuButton'
import { featuredItem, isItemActive, navGroups, type FeaturedItem, type NavGroupEntry } from './nav'
import { ShellFrame } from './ShellFrame'

export interface ShellUser {
  name: string
  email: string
}

interface AppShellProps {
  user: ShellUser
  onLogout: () => void
  loggingOut?: boolean
}

function NavGroups({ groups }: { groups: NavGroupEntry[] }) {
  const baseId = useId()
  const { pathname } = useLocation()
  return groups.map(({ group, items }, index) => (
    <div key={group} className="nav-group" role="group" aria-labelledby={`${baseId}-${index}`}>
      <span className="nav-group-title" id={`${baseId}-${index}`}>
        {group}
      </span>
      {items.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          className="nav-link"
          aria-current={isItemActive(item, pathname) ? 'page' : undefined}
        >
          {item.label}
        </Link>
      ))}
    </div>
  ))
}

/** O item destacado (Perguntar): a ação primária do DS no topo da barra lateral, com o ícone dele. */
function FeaturedLink({ item }: { item: FeaturedItem }) {
  const { pathname } = useLocation()
  const Icon = item.icon
  return (
    <Link
      to={item.to}
      className={`btn btn-primary ${styles.featured}`}
      aria-current={isItemActive(item, pathname) ? 'page' : undefined}
    >
      <Icon size={16} aria-hidden="true" />
      {item.label}
    </Link>
  )
}

/**
 * A conta no cabeçalho: nome e e-mail, e os botões de ajuda, de configurações e de sair. Ajuda e
 * configurações abrem menus com os itens da seção `header` do nav; escolher um item navega sem mexer
 * na barra lateral.
 */
function Account({ user, onLogout, loggingOut }: AppShellProps) {
  const help = useHelp()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const { header } = navGroups()
  const itemsOf = (group: string): MenuEntry[] =>
    (header.find((entry) => entry.group === group)?.items ?? []).map((item) => ({
      key: item.to,
      label: isItemActive(item, pathname) ? <strong>{item.label}</strong> : item.label,
      onSelect: () => navigate(item.to),
    }))
  const helpItems: MenuEntry[] = [
    { key: 'pagina', label: 'Ajuda desta página', kbd: '?', onSelect: () => help?.openHelp() },
    ...itemsOf('Ajuda'),
  ]

  return (
    <div className={styles.account}>
      <div className={styles.user}>
        <strong>{user.name}</strong>
        <span className="text-muted">{user.email}</span>
      </div>
      <div className={styles.actions}>
        <MenuButton className="btn btn-secondary btn-icon" buttonLabel="Ajuda" label="Ajuda" items={helpItems}>
          <CircleHelp size={16} aria-hidden="true" />
        </MenuButton>
        <MenuButton
          className="btn btn-secondary btn-icon"
          buttonLabel="Configurações"
          label="Minhas configurações"
          items={itemsOf('Minhas configurações')}
        >
          <Settings size={16} aria-hidden="true" />
        </MenuButton>
        <span className={styles.bar} aria-hidden="true" />
        <button
          type="button"
          className="btn btn-secondary btn-icon"
          aria-label={loggingOut ? 'Saindo…' : 'Sair'}
          title="Sair"
          onClick={onLogout}
          disabled={loggingOut}
        >
          <LogOut size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}

export function AppShell({ user, onLogout, loggingOut = false }: AppShellProps) {
  const { main } = navGroups()
  const featured = featuredItem()

  return (
    <HelpProvider>
      <ShellFrame
        brand={<Brand to="/" />}
        account={<Account user={user} onLogout={onLogout} loggingOut={loggingOut} />}
        sidebar={
          <nav aria-label="Principal" className={styles.nav}>
            {featured && <FeaturedLink item={featured} />}
            <NavGroups groups={main} />
          </nav>
        }
      >
        <ConnectionBanner />
        <ImportProvider>
          <Outlet />
        </ImportProvider>
      </ShellFrame>
    </HelpProvider>
  )
}
