import { useId, useState, type SyntheticEvent } from 'react'
import { Link, Outlet, useLocation } from 'react-router'
import styles from './AppShell.module.css'
import { Brand } from './Brand'
import { ImportProvider } from '../features/import/ImportProvider'
import { HelpProvider } from './HelpProvider'
import { isInMoreSection, isItemActive, navGroups, type NavGroupEntry } from './nav'
import { ShellFrame } from './ShellFrame'
import { applyThemePreference, readThemePreference, type ThemePreference } from './theme'

export interface ShellUser {
  name: string
  email: string
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

export function AppShell({ user, onLogout, loggingOut = false }: AppShellProps) {
  const [theme, setTheme] = useState<ThemePreference>(readThemePreference)
  const { pathname } = useLocation()
  // "Configurações e ajuda" abre sozinha numa rota dela; fora isso, guarda a escolha da pessoa.
  const [moreOpen, setMoreOpen] = useState(false)
  const [moreClosedAt, setMoreClosedAt] = useState<string | null>(null)
  const inMore = isInMoreSection(pathname)
  const moreShown = moreOpen || (inMore && moreClosedAt !== pathname)
  const themeId = useId()
  const { main, more } = navGroups()

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
      <ShellFrame
        brand={<Brand to="/" />}
        sidebar={
          <>
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
          </>
        }
      >
        <ImportProvider>
          <Outlet />
        </ImportProvider>
      </ShellFrame>
    </HelpProvider>
  )
}
