import { useQuery } from '@tanstack/react-query'
import { api } from '../../api/client'
import { unwrap } from '../../api/problem'

/** `SignupRequest.password.minLength` no contrato. */
export const MIN_PASSWORD = 12

const SIGNUP_INFO_KEY = ['signup-info'] as const

/** Se o cadastro está aberto e o aviso em vigor (texto e versão), lidos de `GET /auth/signup`. */
export function useSignupInfo() {
  return useQuery({
    queryKey: SIGNUP_INFO_KEY,
    queryFn: () => unwrap(api.GET('/api/v1/auth/signup')),
    staleTime: 5 * 60_000,
  })
}
