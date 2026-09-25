import { useId, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router'
import styles from './AppShell.module.css'
import { navGroups, type Role } from './nav'
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

export function AppShell({ user, onLogout, loggingOut = false }: AppShellProps) {
  const [theme, setTheme] = useState<ThemePreference>(readThemePreference)
  const { pathname } = useLocation()
  // O menu compacto vale para a rota em que foi aberto: navegar o fecha.
  const [menuOpenAt, setMenuOpenAt] = useState<string | null>(null)
  const menuOpen = menuOpenAt === pathname
  const navId = useId()
  const themeId = useId()

  function changeTheme(value: ThemePreference) {
    setTheme(value)
    applyThemePreference(value)
  }

  return (
    <div className={styles.shell}>
      <a className="skip-link" href="#conteudo">
        Pular para o conteúdo
      </a>
      <header className={styles.topbar}>
        <NavLink to="/" className={styles.brand}>
          eclume
        </NavLink>
        <button
          type="button"
          className={`btn btn-ghost ${styles.menuButton}`}
          aria-expanded={menuOpen}
          aria-controls={navId}
          onClick={() => setMenuOpenAt(menuOpen ? null : pathname)}
        >
          Menu
        </button>
      </header>
      <aside className={styles.sidebar} id={navId} data-open={menuOpen}>
        <NavLink to="/" className={`${styles.brand} ${styles.brandSide}`}>
          eclume
        </NavLink>
        <nav aria-label="Principal" className={styles.nav}>
          {navGroups(user.role).map(({ group, items }) => (
            <div key={group} className={styles.group}>
              <h2 className={styles.groupTitle}>{group}</h2>
              <ul>
                {items.map((item) => (
                  <li key={item.to}>
                    <NavLink to={item.to} end={item.to === '/'} className={styles.link}>
                      {item.label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <div className={styles.footer}>
          <div className={styles.user}>
            <span className={styles.userName}>{user.name}</span>
            <span className={styles.userEmail}>{user.email}</span>
          </div>
          <div className={styles.theme}>
            <label htmlFor={themeId}>Tema</label>
            <select
              id={themeId}
              className="select"
              value={theme}
              onChange={(event) => changeTheme(event.target.value as ThemePreference)}
            >
              <option value="system">Do sistema</option>
              <option value="light">Claro</option>
              <option value="dark">Escuro</option>
            </select>
          </div>
          <button type="button" className="btn" onClick={onLogout} disabled={loggingOut}>
            {loggingOut ? 'Saindo…' : 'Sair'}
          </button>
        </div>
      </aside>
      <main id="conteudo" tabIndex={-1} className={styles.main}>
        <Outlet />
      </main>
    </div>
  )
}
