import { Link } from 'react-router'
import { AdminPageHead } from './AdminPageHead'
import { ADMIN_HOME_PATH } from './adminSession'

/** A nonexistent route inside the panel: stays in the admin frame. */
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
