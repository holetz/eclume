import { BrowserRouter } from 'react-router'
import { AppProviders } from './app/providers'
import { createQueryClient } from './app/queryClient'
import { AppRoutes } from './app/routes'

const queryClient = createQueryClient()

function App() {
  return (
    <AppProviders client={queryClient}>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </AppProviders>
  )
}

export default App
