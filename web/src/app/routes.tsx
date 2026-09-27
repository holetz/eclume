import { lazy, Suspense, type ComponentType } from 'react'
import { Link, Route, Routes } from 'react-router'
import { LoginPage } from '../features/auth/LoginPage'
import { LibraryPage } from '../features/library/LibraryPage'
import { RequireSession } from './RequireSession'
import { usePageTitle } from './usePageTitle'

// A biblioteca e o login vão no bundle inicial; as outras áreas carregam sob demanda, cada uma no
// seu chunk (o conversor de mídia do import e o react-markdown dos resumos são os mais pesados).
const named = <K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) =>
  lazy(() => load().then((module) => ({ default: module[name] })))

const AdminRoutes = named(() => import('../features/admin/AdminRoutes'), 'AdminRoutes')
const InvitationPage = named(() => import('../features/auth/InvitationPage'), 'InvitationPage')
const CollectionsPage = named(() => import('../features/collections/CollectionsPage'), 'CollectionsPage')
const DesktopPage = named(() => import('../features/desktop/DesktopPage'), 'DesktopPage')
const ImportPage = named(() => import('../features/import/ImportPage'), 'ImportPage')
const PeoplePage = named(() => import('../features/people/PeoplePage'), 'PeoplePage')
const PersonPage = named(() => import('../features/people/PersonPage'), 'PersonPage')
const SearchPage = named(() => import('../features/search/SearchPage'), 'SearchPage')
const TokensPage = named(() => import('../features/tokens/TokensPage'), 'TokensPage')
const RecordingPage = named(() => import('../features/transcript/RecordingPage'), 'RecordingPage')

function page(Page: ComponentType) {
  return (
    <Suspense fallback={<p role="status">Carregando…</p>}>
      <Page />
    </Suspense>
  )
}

function NotFoundPage() {
  usePageTitle('Página não encontrada')
  return (
    <section>
      <h1>Página não encontrada</h1>
      <p className="text-muted">
        O endereço não existe ou mudou. <Link to="/">Voltar à biblioteca</Link>.
      </p>
    </section>
  )
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/entrar" element={<LoginPage />} />
      <Route path="/convite/:token" element={page(InvitationPage)} />
      <Route element={<RequireSession />}>
        <Route index element={<LibraryPage />} />
        <Route path="/gravacoes/:id" element={page(RecordingPage)} />
        <Route path="/importar" element={page(ImportPage)} />
        <Route path="/pessoas" element={page(PeoplePage)} />
        <Route path="/pessoas/:id" element={page(PersonPage)} />
        <Route path="/busca" element={page(SearchPage)} />
        <Route path="/colecoes" element={page(CollectionsPage)} />
        <Route path="/tokens" element={page(TokensPage)} />
        <Route path="/app-desktop" element={page(DesktopPage)} />
        <Route path="/admin/*" element={page(AdminRoutes)} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  )
}
