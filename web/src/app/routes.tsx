import { lazy, Suspense, type ComponentType } from 'react'
import { Navigate, type RouteObject } from 'react-router'
import { LoginPage } from '../features/auth/LoginPage'
import { LibraryPage } from '../features/library/LibraryPage'
import { NotFoundPage } from './NotFoundPage'
import { RequireSession } from './RequireSession'
import { RootError, RouteError } from './RouteError'

// A biblioteca e o login vão no bundle inicial; as outras áreas carregam sob demanda, cada uma no
// seu chunk (o react-markdown dos resumos é o mais pesado; o conversor do import carrega com o modal).
const named = <K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) =>
  lazy(() => load().then((module) => ({ default: module[name] })))

const AdminRoutes = named(() => import('../features/admin/AdminRoutes'), 'AdminRoutes')
const AdminSignInPage = named(() => import('../features/admin/AdminSignInPage'), 'AdminSignInPage')
const AgendaTypesPage = named(() => import('../features/organize/AgendaTypesPage'), 'AgendaTypesPage')
const ArticlePage = named(() => import('../features/help/ArticlePage'), 'ArticlePage')
const ChatPage = named(() => import('../features/chat/ChatPage'), 'ChatPage')
const CollectionsPage = named(() => import('../features/collections/CollectionsPage'), 'CollectionsPage')
const EnvironmentPage = named(() => import('../features/environment/EnvironmentPage'), 'EnvironmentPage')
const AccountPage = named(() => import('../features/account/AccountPage'), 'AccountPage')
const DesktopPage = named(() => import('../features/desktop/DesktopPage'), 'DesktopPage')
const FieldsPage = named(() => import('../features/organize/FieldsPage'), 'FieldsPage')
const HelpCenterPage = named(() => import('../features/help/HelpCenterPage'), 'HelpCenterPage')
const McpPage = named(() => import('../features/connect/McpPage'), 'McpPage')
const MobilePage = named(() => import('../features/connect/MobilePage'), 'MobilePage')
const PairPage = named(() => import('../features/connect/PairPage'), 'PairPage')
const PeoplePage = named(() => import('../features/people/PeoplePage'), 'PeoplePage')
const PersonPage = named(() => import('../features/people/PersonPage'), 'PersonPage')
const SearchPage = named(() => import('../features/search/SearchPage'), 'SearchPage')
const TagsPage = named(() => import('../features/tags/TagsPage'), 'TagsPage')
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

// A mesma árvore serve o `createBrowserRouter` do app e o `createMemoryRouter` dos testes.
// Dois níveis de erro: a raiz cobre as rotas fora do shell com página inteira; a rota sem caminho
// dentro do `RequireSession` mostra o erro no `Outlet`, com o shell de pé.
export const routes: RouteObject[] = [
  {
    errorElement: <RootError />,
    children: [
      { path: '/entrar', element: <LoginPage /> },
      { path: '/cadastro', element: page(SignupPage) },
      // Quem lê o QR com a câmera comum cai aqui, sem sessão.
      { path: '/parear', element: page(PairPage) },
      // O painel admin fica fora da sessão do usuário: conta, login e guarda próprios.
      { path: '/admin/entrar', element: page(AdminSignInPage) },
      { path: '/admin/*', element: page(AdminRoutes) },
      {
        element: <RequireSession />,
        children: [
          {
            errorElement: <RouteError />,
            children: [
              { index: true, element: <LibraryPage /> },
              { path: '/gravacoes/:id', element: page(RecordingPage) },
              // Importar é o modal da biblioteca; a rota antiga abre o modal.
              { path: '/importar', element: <Navigate to="/?importar=1" replace /> },
              { path: '/pessoas', element: page(PeoplePage) },
              { path: '/pessoas/:id', element: page(PersonPage) },
              { path: '/busca', element: page(SearchPage) },
              { path: '/perguntas', element: page(ChatPage) },
              { path: '/colecoes', element: page(CollectionsPage) },
              { path: '/tags', element: page(TagsPage) },
              { path: '/config/campos', element: page(FieldsPage) },
              { path: '/config/agendas', element: page(AgendaTypesPage) },
              { path: '/config/mcp', element: page(McpPage) },
              { path: '/config/conta', element: page(AccountPage) },
              { path: '/config/ambiente', element: page(EnvironmentPage) },
              { path: '/tokens', element: page(TokensPage) },
              { path: '/app-desktop', element: page(DesktopPage) },
              { path: '/app-movel', element: page(MobilePage) },
              { path: '/ajuda', element: page(HelpCenterPage) },
              { path: '/ajuda/:slug', element: page(ArticlePage) },
              { path: '*', element: <NotFoundPage /> },
            ],
          },
        ],
      },
    ],
  },
]
