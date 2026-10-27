import { useQuery } from '@tanstack/react-query'
import { api } from '../../api/client'
import { unwrap } from '../../api/problem'

/** The server's public descriptor (`GET /server`): address, MCP address and CA fingerprint. */
export function useServerInfo() {
  return useQuery({
    queryKey: ['server'],
    queryFn: () => unwrap(api.GET('/api/v1/server')),
    staleTime: Infinity,
  })
}
