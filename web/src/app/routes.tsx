import { Link, Route, Routes } from 'react-router'
import { AdminRoutes } from '../features/admin/AdminRoutes'
import { InvitationPage } from '../features/auth/InvitationPage'
import { LoginPage } from '../features/auth/LoginPage'
import { DesktopPage } from '../features/desktop/DesktopPage'
import { ImportPage } from '../features/import/ImportPage'
import { LibraryPage } from '../features/library/LibraryPage'
import { TokensPage } from '../features/tokens/TokensPage'
import { RecordingPage } from '../features/transcript/RecordingPage'
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

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/entrar" element={<LoginPage />} />
      <Route path="/convite/:token" element={<InvitationPage />} />
      <Route element={<RequireSession />}>
        <Route index element={<LibraryPage />} />
        <Route path="/gravacoes/:id" element={<RecordingPage />} />
        <Route path="/importar" element={<ImportPage />} />
        <Route path="/tokens" element={<TokensPage />} />
        <Route path="/app-desktop" element={<DesktopPage />} />
        <Route path="/admin/*" element={<AdminRoutes />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  )
}
