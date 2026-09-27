import { Menu, X } from 'lucide-react'
import { useId, useState, type SyntheticEvent } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router'
import styles from './AppShell.module.css'
import { Brand } from './Brand'
import { HelpProvider } from './HelpProvider'
import { isInMoreSection, navGroups, type NavGroupEntry, type Role } from './nav'
import { applyThemePreference, readThemePreference, type ThemePreference } from './theme'

export interface ShellUser {
  name: string
  email: string
  role: Role
}

interface AppShellProps {
  user: ShellUser
  onLogout: () => void
  loggingOut?: boolean
}

const THEMES: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'Sistema' },
  { value: 'light', label: 'Claro' },
  { value: 'dark', label: 'Escuro' },
]

function NavGroups({ groups }: { groups: NavGroupEntry[] }) {
  const baseId = useId()
  return groups.map(({ group, items }, index) => (
    <div key={group} className="nav-group" role="group" aria-labelledby={`${baseId}-${index}`}>
      <span className="nav-group-title" id={`${baseId}-${index}`}>
        {group}
      </span>
      {items.map((item) => (
        <NavLink key={item.to} to={item.to} end={item.to === '/'} className="nav-link">
          {item.label}
        </NavLink>
      ))}
    </div>
  ))
}

export function AppShell({ user, onLogout, loggingOut = false }: AppShellProps) {
  const [theme, setTheme] = useState<ThemePreference>(readThemePreference)
  const { pathname } = useLocation()
  // O menu compacto vale para a rota em que foi aberto: navegar o fecha.
  const [menuOpenAt, setMenuOpenAt] = useState<string | null>(null)
  const menuOpen = menuOpenAt === pathname
  // "Configurações e ajuda" abre sozinha numa rota dela; fora isso, guarda a escolha da pessoa.
  const [moreOpen, setMoreOpen] = useState(false)
  const [moreClosedAt, setMoreClosedAt] = useState<string | null>(null)
  const inMore = isInMoreSection(pathname)
  const moreShown = moreOpen || (inMore && moreClosedAt !== pathname)
  const navId = useId()
  const themeId = useId()
  const { main, more } = navGroups(user.role)

  function changeTheme(value: ThemePreference) {
    setTheme(value)
    applyThemePreference(value)
  }

  function toggleMore(event: SyntheticEvent<HTMLDetailsElement>) {
    const open = event.currentTarget.open
    if (open === moreShown) return
    setMoreOpen(open)
    setMoreClosedAt(open ? null : pathname)
  }

  return (
    <HelpProvider>
      <div className={`shell ${styles.shell}`}>
        <a className="skip-link" href="#conteudo">
          Pular para o conteúdo
        </a>
        <header className={styles.topbar}>
          <Brand to="/" />
          <button
            type="button"
            className="btn btn-secondary"
            aria-expanded={menuOpen}
            aria-controls={navId}
            onClick={() => setMenuOpenAt(menuOpen ? null : pathname)}
          >
            {menuOpen ? <X size={16} aria-hidden /> : <Menu size={16} aria-hidden />}
            Menu
          </button>
        </header>
        <aside className={`sidebar ${styles.sidebar}`} id={navId} data-open={menuOpen}>
          <Brand to="/" className={styles.brandSide} />
          <nav aria-label="Principal" className={styles.nav}>
            <NavGroups groups={main} />
            {more.length > 0 && (
              <details className="nav-more" open={moreShown} onToggle={toggleMore}>
                <summary>Configurações e ajuda</summary>
                <NavGroups groups={more} />
              </details>
            )}
          </nav>
          <div className={`sidebar-footer ${styles.footer}`}>
            <div className={styles.user}>
              <strong>{user.name}</strong>
              <span className="text-muted">{user.email}</span>
            </div>
            <div className={styles.theme}>
              <span id={themeId}>Tema</span>
              <div className={`seg ${styles.seg}`} role="radiogroup" aria-labelledby={themeId}>
                {THEMES.map((option) => (
                  <label key={option.value} className="seg-opt">
                    <input
                      type="radio"
                      name={themeId}
                      value={option.value}
                      checked={theme === option.value}
                      onChange={() => changeTheme(option.value)}
                    />
                    {option.label}
                  </label>
                ))}
              </div>
            </div>
            <button type="button" className="btn btn-secondary" onClick={onLogout} disabled={loggingOut}>
              {loggingOut ? 'Saindo…' : 'Sair'}
            </button>
          </div>
        </aside>
        <main id="conteudo" tabIndex={-1} className={`main ${styles.main}`}>
          <Outlet />
        </main>
      </div>
    </HelpProvider>
  )
}
