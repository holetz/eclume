import { lazy, Suspense, type ComponentType } from 'react'
import { Navigate, Route, Routes } from 'react-router'
import { LoginPage } from '../features/auth/LoginPage'
import { LibraryPage } from '../features/library/LibraryPage'
import { NotFoundPage } from './NotFoundPage'
import { RequireSession } from './RequireSession'

// A biblioteca e o login vão no bundle inicial; as outras áreas carregam sob demanda, cada uma no
// seu chunk (o react-markdown dos resumos é o mais pesado; o conversor do import carrega com o modal).
const named = <K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) =>
  lazy(() => load().then((module) => ({ default: module[name] })))

const AdminRoutes = named(() => import('../features/admin/AdminRoutes'), 'AdminRoutes')
const AdminSignInPage = named(() => import('../features/admin/AdminSignInPage'), 'AdminSignInPage')
const AgendaTypesPage = named(() => import('../features/organize/AgendaTypesPage'), 'AgendaTypesPage')
const ArticlePage = named(() => import('../features/help/ArticlePage'), 'ArticlePage')
const CollectionsPage = named(() => import('../features/collections/CollectionsPage'), 'CollectionsPage')
const EnvironmentPage = named(() => import('../features/environment/EnvironmentPage'), 'EnvironmentPage')
const DesktopPage = named(() => import('../features/desktop/DesktopPage'), 'DesktopPage')
const FieldsPage = named(() => import('../features/organize/FieldsPage'), 'FieldsPage')
const HelpCenterPage = named(() => import('../features/help/HelpCenterPage'), 'HelpCenterPage')
const McpPage = named(() => import('../features/connect/McpPage'), 'McpPage')
const MobilePage = named(() => import('../features/connect/MobilePage'), 'MobilePage')
const PairPage = named(() => import('../features/connect/PairPage'), 'PairPage')
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
      {/* Quem lê o QR com a câmera comum cai aqui, sem sessão. */}
      <Route path="/parear" element={page(PairPage)} />
      {/* O painel admin fica fora da sessão do usuário: conta, login e guarda próprios. */}
      <Route path="/admin/entrar" element={page(AdminSignInPage)} />
      <Route path="/admin/*" element={page(AdminRoutes)} />
      <Route element={<RequireSession />}>
        <Route index element={<LibraryPage />} />
        <Route path="/gravacoes/:id" element={page(RecordingPage)} />
        {/* Importar é o modal da biblioteca; a rota antiga abre o modal. */}
        <Route path="/importar" element={<Navigate to="/?importar=1" replace />} />
        <Route path="/pessoas" element={page(PeoplePage)} />
        <Route path="/pessoas/:id" element={page(PersonPage)} />
        <Route path="/busca" element={page(SearchPage)} />
        <Route path="/colecoes" element={page(CollectionsPage)} />
        <Route path="/config/campos" element={page(FieldsPage)} />
        <Route path="/config/agendas" element={page(AgendaTypesPage)} />
        <Route path="/config/mcp" element={page(McpPage)} />
        <Route path="/config/ambiente" element={page(EnvironmentPage)} />
        <Route path="/tokens" element={page(TokensPage)} />
        <Route path="/app-desktop" element={page(DesktopPage)} />
        <Route path="/app-movel" element={page(MobilePage)} />
        <Route path="/ajuda" element={page(HelpCenterPage)} />
        <Route path="/ajuda/:slug" element={page(ArticlePage)} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  )
}
