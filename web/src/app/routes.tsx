import { Link, Route, Routes } from 'react-router'
import { LoginPage } from '../features/auth/LoginPage'
import { CollectionsPage } from '../features/collections/CollectionsPage'
import { DesktopPage } from '../features/desktop/DesktopPage'
import { ImportPage } from '../features/import/ImportPage'
import { LibraryPage } from '../features/library/LibraryPage'
import { PeoplePage } from '../features/people/PeoplePage'
import { PersonPage } from '../features/people/PersonPage'
import { SearchPage } from '../features/search/SearchPage'
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
      <Route element={<RequireSession />}>
        <Route index element={<LibraryPage />} />
        <Route path="/gravacoes/:id" element={<RecordingPage />} />
        <Route path="/importar" element={<ImportPage />} />
        <Route path="/pessoas" element={<PeoplePage />} />
        <Route path="/pessoas/:id" element={<PersonPage />} />
        <Route path="/busca" element={<SearchPage />} />
        <Route path="/colecoes" element={<CollectionsPage />} />
        <Route path="/tokens" element={<TokensPage />} />
        <Route path="/app-desktop" element={<DesktopPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  )
}
