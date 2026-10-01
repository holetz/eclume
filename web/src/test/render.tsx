// Renderiza o app inteiro numa rota, com um QueryClient novo e sem retry.
import { render } from '@testing-library/react'
import { createMemoryRouter } from 'react-router'
import { RouterProvider } from 'react-router/dom'
import { AppProviders } from '../app/providers'
import { createQueryClient } from '../app/queryClient'
import { routes } from '../app/routes'

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
