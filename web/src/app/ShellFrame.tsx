import { Menu, X } from 'lucide-react'
import { useId, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router'
import styles from './ShellFrame.module.css'

interface ShellFrameProps {
  /** A marca, no topo da barra lateral e, em tela estreita, na barra superior. */
  brand: ReactNode
  /** O resto da barra lateral: navegação e rodapé. */
  sidebar: ReactNode
  children: ReactNode
}

/**
 * A moldura `.shell` do Design System, comum ao app e ao painel admin: barra lateral fixa e, abaixo
 * de 56rem, a barra superior com a marca e o botão Menu, que abre a barra lateral por cima.
 */
export function ShellFrame({ brand, sidebar, children }: ShellFrameProps) {
  const { pathname } = useLocation()
  // O menu compacto vale para a rota em que foi aberto: navegar o fecha.
  const [menuOpenAt, setMenuOpenAt] = useState<string | null>(null)
  const menuOpen = menuOpenAt === pathname
  const navId = useId()

  return (
    <div className={`shell ${styles.shell}`}>
      <a className="skip-link" href="#conteudo">
        Pular para o conteúdo
      </a>
      <header className={styles.topbar}>
        {brand}
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
        <div className={styles.brandSide}>{brand}</div>
        {sidebar}
      </aside>
      <main id="conteudo" tabIndex={-1} className={`main ${styles.main}`}>
        {children}
      </main>
    </div>
  )
}
