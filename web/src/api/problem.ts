// Erros da API em application/problem+json (RFC 9457). A UI decide por `code`, nunca por `title`.
import type { Schemas } from './client'

export type Problem = Schemas['Problem']

export class ApiError extends Error {
  readonly status: number
  readonly problem: Problem | null

  constructor(status: number, problem: Problem | null) {
    super(problem?.detail ?? problem?.title ?? `HTTP ${status}`)
    this.name = 'ApiError'
    this.status = status
    this.problem = problem
  }

  get code(): string | null {
    return this.problem?.code ?? null
  }
}

function isProblem(value: unknown): value is Problem {
  return typeof value === 'object' && value !== null && typeof (value as Problem).code === 'string'
}

/** Devolve `data` de uma chamada do openapi-fetch, ou lança `ApiError` com o problem. */
export async function unwrap<T>(
  call: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  const { data, error, response } = await call
  if (!response.ok) throw new ApiError(response.status, isProblem(error) ? error : null)
  return data as T
}

const MESSAGES: Record<string, string> = {
  unauthorized: 'Sua sessão expirou. Entre de novo.',
  insufficient_scope: 'Seu acesso não inclui esta ação.',
  forbidden: 'Você não tem permissão para esta ação.',
  not_found: 'Não encontrado. Pode ter sido excluído.',
  conflict: 'Conflito com o estado atual. Recarregue a página e tente de novo.',
  hash_mismatch: 'O arquivo chegou diferente do enviado. Tente importar de novo.',
  upload_expired: 'O envio expirou. Recomece o import.',
  rate_limited: 'Muitas requisições seguidas. Aguarde um instante e tente de novo.',
}

/** Mensagem em pt-BR para qualquer erro vindo de uma chamada à API. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const problem = error.problem
    if (problem?.code === 'validation_failed') {
      const fields = problem.errors?.map((e) => `${e.field}: ${e.message}`).join('; ')
      return fields ? `Confira os campos — ${fields}.` : 'Confira os campos do formulário.'
    }
    if (problem && MESSAGES[problem.code]) return MESSAGES[problem.code]
    return problem?.detail ?? `O servidor respondeu com erro (HTTP ${error.status}).`
  }
  if (error instanceof TypeError) return 'Sem conexão com o servidor. Confira a rede e tente de novo.'
  return error instanceof Error ? error.message : 'Algo deu errado.'
}
