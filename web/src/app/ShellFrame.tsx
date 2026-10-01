import { Menu, X } from 'lucide-react'
import { useId, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router'
import { NavigatedPathContext } from './pageFocus'
import styles from './ShellFrame.module.css'

interface ShellFrameProps {
  /** A marca: no cabeçalho, ou no topo da barra lateral quando não há cabeçalho. */
  brand: ReactNode
  /** O resto da barra lateral: navegação e rodapé. */
  sidebar: ReactNode
  /**
   * A conta, à direita de um cabeçalho estreito em qualquer largura (o app do usuário). Sem ela
   * (o painel admin), a marca fica na barra lateral e o cabeçalho só aparece em tela estreita.
   */
  account?: ReactNode
  children: ReactNode
}

/**
 * A moldura `.shell` do Design System, comum ao app e ao painel admin: barra lateral fixa e, abaixo
 * de 56rem, o botão Menu no cabeçalho, que abre a barra lateral por cima. A altura do cabeçalho fixo
 * fica em `--shell-header`, para as telas que grudam elementos no topo.
 */
export function ShellFrame({ brand, sidebar, account, children }: ShellFrameProps) {
  const { pathname } = useLocation()
  // A partir da primeira troca de rota, o `PageHead` da página nova leva o foco ao título.
  const [firstPath] = useState(pathname)
  const [navigated, setNavigated] = useState(false)
  if (!navigated && pathname !== firstPath) setNavigated(true)
  // O menu compacto vale para a rota em que foi aberto: navegar o fecha.
  const [menuOpenAt, setMenuOpenAt] = useState<string | null>(null)
  const menuOpen = menuOpenAt === pathname
  const navId = useId()

  return (
    <NavigatedPathContext.Provider value={navigated ? pathname : null}>
      <div className={`shell ${styles.shell}`} data-header={account ? '' : undefined}>
        <a className="skip-link" href="#conteudo">
          Pular para o conteúdo
        </a>
        <header className={styles.topbar}>
          {brand}
          {account && <div className={styles.account}>{account}</div>}
          <button
            type="button"
            className={`btn btn-secondary ${styles.menuButton}`}
            aria-expanded={menuOpen}
            aria-controls={navId}
            onClick={() => setMenuOpenAt(menuOpen ? null : pathname)}
          >
            {menuOpen ? <X size={16} aria-hidden /> : <Menu size={16} aria-hidden />}
            Menu
          </button>
        </header>
        <aside className={`sidebar ${styles.sidebar}`} id={navId} data-open={menuOpen}>
          {!account && <div className={styles.brandSide}>{brand}</div>}
          {sidebar}
        </aside>
        <main id="conteudo" tabIndex={-1} className={`main ${styles.main}`}>
          {children}
        </main>
      </div>
    </NavigatedPathContext.Provider>
  )
}
