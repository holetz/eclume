import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { useEffect, type ReactNode } from 'react'
import { onUnauthorized } from '../api/client'
import { clearUserQueries } from './accountScope'
import { ME_KEY } from './session'

export function AppProviders({ client, children }: { client: QueryClient; children: ReactNode }) {
  // Um 401 em qualquer chamada encerra a sessão local e apaga o cache de dados do usuário; a guarda
  // de rota leva ao login. Os rascunhos da aba ficam: a mesma conta que volta os reencontra.
  useEffect(
    () =>
      onUnauthorized(() => {
        // Só a sessão que existia e caiu limpa o cache; o 401 de quem nunca entrou (o `/me` do login,
        // do cadastro) não pode levar junto as consultas públicas dessas telas.
        if (client.getQueryData(ME_KEY)) clearUserQueries(client, ME_KEY)
        client.setQueryData(ME_KEY, null)
      }),
    [client],
  )
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}
