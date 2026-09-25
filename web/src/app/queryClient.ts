import { QueryClient } from '@tanstack/react-query'
import { ApiError } from '../api/problem'

export function createQueryClient(options: { retry?: boolean } = {}) {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Erro do cliente (4xx) não melhora com nova tentativa; falha de rede e 5xx, sim.
        retry:
          options.retry === false
            ? false
            : (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
        refetchOnWindowFocus: false,
        staleTime: 10_000,
      },
    },
  })
}
