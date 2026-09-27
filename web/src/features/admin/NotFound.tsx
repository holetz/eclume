import { Link } from 'react-router'
import { AdminPageHead } from './AdminPageHead'
import { ADMIN_HOME_PATH } from './adminSession'

/** Rota inexistente dentro do painel: continua na moldura do admin. */
export function NotFound() {
  return (
    <>
      <AdminPageHead title="Página não encontrada" />
      <p>
        <Link to={ADMIN_HOME_PATH}>Ir para Usuários</Link>
      </p>
    </>
  )
}
