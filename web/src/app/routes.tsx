import { lazy, Suspense, type ComponentType } from 'react'
import { Navigate, type RouteObject } from 'react-router'
import { LoginPage } from '../features/auth/LoginPage'
import { LibraryPage } from '../features/library/LibraryPage'
import { NotFoundPage } from './NotFoundPage'
import { RequireSession } from './RequireSession'
import { RootError, RouteError } from './RouteError'

// A biblioteca e o login vão no bundle inicial; as outras áreas carregam sob demanda, cada uma no
// seu chunk (o react-markdown dos resumos é o mais pesado; o conversor do import carrega com o modal).
// O `preload` carrega o chunk antes da rota montar: os testes o chamam no `beforeAll` (`preloadRoute`),
// fora do tempo do `findBy`.
const named = <K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) => {
  let loading: Promise<{ default: ComponentType }> | null = null
  const preload = () => (loading ??= load().then((module) => ({ default: module[name] })))
  return Object.assign(lazy(preload), { preload })
}

type LazyPage = ReturnType<typeof named>

/** Os `preload` das páginas sob demanda de uma rota, no `handle` dela. */
export interface RouteHandle {
  preload?: () => Promise<unknown>
}

const AdminRoutes = named(() => import('../features/admin/AdminRoutes'), 'AdminRoutes')
const AdminSignInPage = named(() => import('../features/admin/AdminSignInPage'), 'AdminSignInPage')
const AutomationPage = named(() => import('../features/automation/AutomationPage'), 'AutomationPage')
const AgendaTypesPage = named(() => import('../features/organize/AgendaTypesPage'), 'AgendaTypesPage')
const AgentPage = named(() => import('../features/agent/AgentPage'), 'AgentPage')
const ArticlePage = named(() => import('../features/help/ArticlePage'), 'ArticlePage')
const CollectionsPage = named(() => import('../features/collections/CollectionsPage'), 'CollectionsPage')
const ConversationsPage = named(() => import('../features/agent/ConversationsPage'), 'ConversationsPage')
const SkillsPage = named(() => import('../features/agent/SkillsPage'), 'SkillsPage')
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
const ResetPasswordPage = named(() => import('../features/auth/ResetPasswordPage'), 'ResetPasswordPage')
const RecordingPage = named(() => import('../features/transcript/RecordingPage'), 'RecordingPage')

/** A rota de uma página sob demanda: o `Suspense` com "Carregando…" e o `preload` no `handle`. */
function page(Page: LazyPage): Pick<RouteObject, 'element' | 'handle'> {
  return {
    element: (
      <Suspense fallback={<p role="status">Carregando…</p>}>
        <Page />
      </Suspense>
    ),
    handle: { preload: Page.preload } satisfies RouteHandle,
  }
}

// A mesma árvore serve o `createBrowserRouter` do app e o `createMemoryRouter` dos testes.
// Dois níveis de erro: a raiz cobre as rotas fora do shell com página inteira; a rota sem caminho
// dentro do `RequireSession` mostra o erro no `Outlet`, com o shell de pé.
export const routes: RouteObject[] = [
  {
    errorElement: <RootError />,
    children: [
      { path: '/entrar', element: <LoginPage /> },
      { path: '/cadastro', ...page(SignupPage) },
      // O link que o admin gera: o segredo vem no fragmento, lido antes de qualquer redirecionamento.
      { path: '/redefinir-senha', ...page(ResetPasswordPage) },
      // Quem lê o QR com a câmera comum cai aqui, sem sessão.
      { path: '/parear', ...page(PairPage) },
      // O painel admin fica fora da sessão do usuário: conta, login e guarda próprios.
      { path: '/admin/entrar', ...page(AdminSignInPage) },
      { path: '/admin/*', ...page(AdminRoutes) },
      {
        element: <RequireSession />,
        children: [
          {
            errorElement: <RouteError />,
            children: [
              { index: true, element: <LibraryPage /> },
              { path: '/gravacoes/:id', ...page(RecordingPage) },
              // Importar é o modal da biblioteca; a rota antiga abre o modal.
              { path: '/importar', element: <Navigate to="/?importar=1" replace /> },
              { path: '/pessoas', ...page(PeoplePage) },
              { path: '/pessoas/:id', ...page(PersonPage) },
              { path: '/busca', ...page(SearchPage) },
              // O Agente: a conversa (nova ou guardada), a lista de todas e as habilidades; Perguntas era o nome antigo.
              { path: '/agente/conversas', ...page(ConversationsPage) },
              { path: '/agente/habilidades', ...page(SkillsPage) },
              { path: '/agente/:sessionId?', ...page(AgentPage) },
              { path: '/perguntas', element: <Navigate to="/agente" replace /> },
              { path: '/colecoes', ...page(CollectionsPage) },
              { path: '/tags', ...page(TagsPage) },
              { path: '/config/automacao', ...page(AutomationPage) },
              { path: '/config/campos', ...page(FieldsPage) },
              { path: '/config/agendas', ...page(AgendaTypesPage) },
              { path: '/config/mcp', ...page(McpPage) },
              { path: '/config/conta', ...page(AccountPage) },
              { path: '/config/ambiente', ...page(EnvironmentPage) },
              { path: '/tokens', ...page(TokensPage) },
              { path: '/app-desktop', ...page(DesktopPage) },
              { path: '/app-movel', ...page(MobilePage) },
              { path: '/ajuda', ...page(HelpCenterPage) },
              { path: '/ajuda/:slug', ...page(ArticlePage) },
              { path: '*', element: <NotFoundPage /> },
            ],
          },
        ],
      },
    ],
  },
]
