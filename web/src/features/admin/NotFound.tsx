import { Link } from 'react-router'
import { PageHead } from '../../app/PageHead'
import { ADMIN_HOME_PATH } from './adminSession'

/** Rota inexistente dentro do painel: continua na moldura do admin. */
export function NotFound() {
  return (
    <>
      <PageHead kicker="Painel de administração" title="Página não encontrada" />
      <p>
        <Link to={ADMIN_HOME_PATH}>Ir para Usuários</Link>
      </p>
    </>
  )
}
