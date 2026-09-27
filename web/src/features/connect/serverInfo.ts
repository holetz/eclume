import { useQuery } from '@tanstack/react-query'
import { api } from '../../api/client'
import { unwrap } from '../../api/problem'

/** O descritor público do servidor (`GET /server`): endereço, endereço MCP e impressão da CA. */
export function useServerInfo() {
  return useQuery({
    queryKey: ['server'],
    queryFn: () => unwrap(api.GET('/api/v1/server')),
    staleTime: Infinity,
  })
}
