// Renderiza o app inteiro numa rota, com um QueryClient novo e sem retry.
import { render } from '@testing-library/react'
import { createMemoryRouter, matchRoutes } from 'react-router'
import { RouterProvider } from 'react-router/dom'
import { AppProviders } from '../app/providers'
import { createQueryClient } from '../app/queryClient'
import { routes, type RouteHandle } from '../app/routes'

export function renderApp(path: string) {
  const client = createQueryClient({ retry: false })
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  const view = render(
    <AppProviders client={client}>
      <RouterProvider router={router} />
    </AppProviders>,
  )
  return { ...view, client, router }
}

/**
 * Carrega antes os chunks das páginas sob demanda que as rotas dadas montam. Chamado no `beforeAll`
 * do arquivo de teste, o carregamento cai no `hookTimeout`, e não no `asyncUtilTimeout` do primeiro
 * `findBy`, que estourava com a suíte inteira em paralelo.
 */
export async function preloadRoute(...paths: string[]): Promise<void> {
  const loads = paths.flatMap((path) =>
    (matchRoutes(routes, new URL(path, 'http://eclume').pathname) ?? []).map((match) =>
      (match.route.handle as RouteHandle | undefined)?.preload?.(),
    ),
  )
  await Promise.all(loads)
}
