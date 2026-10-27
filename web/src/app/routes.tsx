import { lazy, Suspense, type ComponentType } from 'react'
import { Navigate, type RouteObject } from 'react-router'
import { LoginPage } from '../features/auth/LoginPage'
import { LibraryPage } from '../features/library/LibraryPage'
import { NotFoundPage } from './NotFoundPage'
import { RequireSession } from './RequireSession'
import { RootError, RouteError } from './RouteError'

// The library and the login go in the initial bundle; the other areas load on demand, each in
// its own chunk (the summaries' react-markdown is the heaviest; the import converter loads with the modal).
// `preload` loads the chunk before the route mounts: the tests call it in `beforeAll` (`preloadRoute`),
// outside the `findBy` time.
const named = <K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) => {
  let loading: Promise<{ default: ComponentType }> | null = null
  const preload = () => (loading ??= load().then((module) => ({ default: module[name] })))
  return Object.assign(lazy(preload), { preload })
}

type LazyPage = ReturnType<typeof named>

/** The `preload`s of a route's on-demand pages, in its `handle`. */
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

/** The route of an on-demand page: the `Suspense` with "Carregando…" and the `preload` in the `handle`. */
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

// The same tree serves the app's `createBrowserRouter` and the tests' `createMemoryRouter`.
// Two error levels: the root covers the routes outside the shell with a full page; the pathless route
// inside `RequireSession` shows the error in the `Outlet`, with the shell up.
export const routes: RouteObject[] = [
  {
    errorElement: <RootError />,
    children: [
      { path: '/entrar', element: <LoginPage /> },
      { path: '/cadastro', ...page(SignupPage) },
      // The link the admin generates: the secret comes in the fragment, read before any redirect.
      { path: '/redefinir-senha', ...page(ResetPasswordPage) },
      // Whoever reads the QR with the ordinary camera lands here, without a session.
      { path: '/parear', ...page(PairPage) },
      // The admin panel stays outside the user session: its own account, login and guard.
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
              // Importing is the library's modal; the old route opens the modal.
              { path: '/importar', element: <Navigate to="/?importar=1" replace /> },
              { path: '/pessoas', ...page(PeoplePage) },
              { path: '/pessoas/:id', ...page(PersonPage) },
              { path: '/busca', ...page(SearchPage) },
              // The Agent: the conversation (new or saved), the list of all and the skills; Perguntas was the old name.
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
