import { createBrowserRouter } from 'react-router'
import { RouterProvider } from 'react-router/dom'
import { AppProviders } from './app/providers'
import { createQueryClient } from './app/queryClient'
import { routes } from './app/routes'

const queryClient = createQueryClient()
const router = createBrowserRouter(routes)

function App() {
  return (
    <AppProviders client={queryClient}>
      <RouterProvider router={router} />
    </AppProviders>
  )
}

export default App
