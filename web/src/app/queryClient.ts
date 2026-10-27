import { QueryClient } from '@tanstack/react-query'
import { ApiError } from '../api/problem'

export function createQueryClient(options: { retry?: boolean } = {}) {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // A client error (4xx) does not improve on retry; a network failure and a 5xx do.
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
