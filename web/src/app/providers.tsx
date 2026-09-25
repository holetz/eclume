import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { useEffect, type ReactNode } from 'react'
import { onUnauthorized } from '../api/client'
import { ME_KEY } from './session'

export function AppProviders({ client, children }: { client: QueryClient; children: ReactNode }) {
  // Um 401 em qualquer chamada encerra a sessão local; a guarda de rota leva ao login.
  useEffect(() => onUnauthorized(() => client.setQueryData(ME_KEY, null)), [client])
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}
