import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { useEffect, type ReactNode } from 'react'
import { onUnauthorized } from '../api/client'
import { clearUserQueries } from './accountScope'
import { ME_KEY } from './session'

export function AppProviders({ client, children }: { client: QueryClient; children: ReactNode }) {
  // A 401 on any call ends the local session and clears the user's data cache; the route guard
  // leads to the login. The tab's drafts stay: the same account coming back finds them again.
  useEffect(
    () =>
      onUnauthorized(() => {
        // Only a session that existed and dropped clears the cache; the 401 of someone who never signed in (the login's
        // `/me`, the signup's) must not take those screens' public queries with it.
        if (client.getQueryData(ME_KEY)) clearUserQueries(client, ME_KEY)
        client.setQueryData(ME_KEY, null)
      }),
    [client],
  )
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}
