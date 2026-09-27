import { lazy, Suspense, type ComponentType } from 'react'
import { Route, Routes } from 'react-router'
import { LoginPage } from '../features/auth/LoginPage'
import { LibraryPage } from '../features/library/LibraryPage'
import { NotFoundPage } from './NotFoundPage'
import { RequireSession } from './RequireSession'

// A biblioteca e o login vão no bundle inicial; as outras áreas carregam sob demanda, cada uma no
// seu chunk (o conversor de mídia do import e o react-markdown dos resumos são os mais pesados).
const named = <K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) =>
  lazy(() => load().then((module) => ({ default: module[name] })))

const AdminRoutes = named(() => import('../features/admin/AdminRoutes'), 'AdminRoutes')
const AdminSignInPage = named(() => import('../features/admin/AdminSignInPage'), 'AdminSignInPage')
const CollectionsPage = named(() => import('../features/collections/CollectionsPage'), 'CollectionsPage')
const DesktopPage = named(() => import('../features/desktop/DesktopPage'), 'DesktopPage')
const ImportPage = named(() => import('../features/import/ImportPage'), 'ImportPage')
const PeoplePage = named(() => import('../features/people/PeoplePage'), 'PeoplePage')
const PersonPage = named(() => import('../features/people/PersonPage'), 'PersonPage')
const SearchPage = named(() => import('../features/search/SearchPage'), 'SearchPage')
const TokensPage = named(() => import('../features/tokens/TokensPage'), 'TokensPage')
const SignupPage = named(() => import('../features/auth/SignupPage'), 'SignupPage')
const RecordingPage = named(() => import('../features/transcript/RecordingPage'), 'RecordingPage')

function page(Page: ComponentType) {
  return (
    <Suspense fallback={<p role="status">Carregando…</p>}>
      <Page />
    </Suspense>
  )
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/entrar" element={<LoginPage />} />
      <Route path="/cadastro" element={page(SignupPage)} />
      {/* O painel admin fica fora da sessão do usuário: conta, login e guarda próprios. */}
      <Route path="/admin/entrar" element={page(AdminSignInPage)} />
      <Route path="/admin/*" element={page(AdminRoutes)} />
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
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  )
}
