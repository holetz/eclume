// Renders the whole app at a route, with a fresh QueryClient and no retry.
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
 * Loads ahead the on-demand page chunks that the given routes mount. Called in the test file's
 * `beforeAll`, the load falls under `hookTimeout`, and not under the `asyncUtilTimeout` of the first
 * `findBy`, which ran out with the whole suite in parallel.
 */
export async function preloadRoute(...paths: string[]): Promise<void> {
  const loads = paths.flatMap((path) =>
    (matchRoutes(routes, new URL(path, 'http://eclume').pathname) ?? []).map((match) =>
      (match.route.handle as RouteHandle | undefined)?.preload?.(),
    ),
  )
  await Promise.all(loads)
}
