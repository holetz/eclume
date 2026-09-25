// Renderiza o app inteiro numa rota, com um QueryClient novo e sem retry.
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { AppProviders } from '../app/providers'
import { createQueryClient } from '../app/queryClient'
import { AppRoutes } from '../app/routes'

export function renderApp(path: string) {
  const client = createQueryClient({ retry: false })
  const view = render(
    <AppProviders client={client}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </AppProviders>,
  )
  return { ...view, client }
}
