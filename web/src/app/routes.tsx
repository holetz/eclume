import { Link, Route, Routes } from 'react-router'
import { LoginPage } from '../features/auth/LoginPage'
import { RequireSession } from './RequireSession'
import { usePageTitle } from './usePageTitle'

function NotFoundPage() {
  usePageTitle('Página não encontrada')
  return (
    <section>
      <h1>Página não encontrada</h1>
      <p className="muted">
        O endereço não existe ou mudou. <Link to="/">Voltar à biblioteca</Link>.
      </p>
    </section>
  )
}

function LibraryPlaceholder() {
  usePageTitle('Biblioteca')
  return <h1>Biblioteca</h1>
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/entrar" element={<LoginPage />} />
      <Route element={<RequireSession />}>
        <Route index element={<LibraryPlaceholder />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  )
}
