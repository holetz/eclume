import { NavLink, Outlet } from 'react-router'
import { useMe } from '../../app/session'
import { usePageTitle } from '../../app/usePageTitle'
import styles from './Admin.module.css'
import { ADMIN_SECTIONS } from './sections'

/** Moldura da área: só para `admin`; esconder o item do menu não é controle de acesso. */
export function AdminLayout() {
  const me = useMe()
  if (me.data?.user.role !== 'admin') return <Forbidden />
  return (
    <div className={styles.layout}>
      <header className={styles.header}>
        <h1>Administração</h1>
        <p className="text-muted">Configuração da organização, contas e saúde do serviço. Mudanças valem para os próximos jobs.</p>
      </header>
      <nav aria-label="Seções da administração" className={styles.tabs}>
        <ul>
          {ADMIN_SECTIONS.map((section) => (
            <li key={section.path}>
              <NavLink to={`/admin/${section.path}`} className={styles.tab}>
                {section.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <Outlet />
    </div>
  )
}

function Forbidden() {
  usePageTitle('Sem permissão')
  return (
    <section className={styles.layout}>
      <h1>Sem permissão</h1>
      <p className="text-muted">Esta área é só para administradores da organização.</p>
    </section>
  )
}
