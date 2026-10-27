// API errors in application/problem+json (RFC 9457). The UI decides by `code`, never by `title`.
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

/** Returns `data` from an openapi-fetch call, or throws `ApiError` with the problem. */
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
  session_required: 'Esta ação só pode ser feita pelo navegador, com a sua sessão.',
  not_found: 'Não encontrado. Pode ter sido excluído.',
  conflict: 'Conflito com o estado atual. Recarregue a página e tente de novo.',
  hash_mismatch: 'O arquivo chegou diferente do enviado. Tente importar de novo.',
  upload_expired: 'O envio expirou. Recomece o import.',
  rate_limited: 'Muitas requisições seguidas. Aguarde um instante e tente de novo.',
}

function formatBytes(bytes: number): string {
  const gib = bytes / 1024 ** 3
  if (gib >= 1) return `${gib.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} GB`
  return `${Math.round(bytes / 1024 ** 2).toLocaleString('pt-BR')} MB`
}

/** Message for an exceeded quota (`quota_exceeded`), from the problem's `quota` and `limit`. */
function quotaMessage(problem: Problem): string {
  const limit = problem.limit ?? 0
  switch (problem.quota) {
    case 'file_bytes':
      return `O arquivo passa do tamanho máximo da sua conta (${formatBytes(limit)}).`
    case 'storage_bytes':
      return `Seu armazenamento chegou ao limite de ${formatBytes(limit)}. Exclua gravações antigas para importar mais.`
    case 'open_uploads':
      return `Sua conta envia até ${limit} arquivos ao mesmo tempo. Espere um envio terminar e tente de novo.`
    case 'agent_requests_24h':
      return `Você chegou ao limite de ${limit} pedidos ao agente em 24 horas. Tente de novo mais tarde.`
    default:
      return 'Sua conta chegou a um limite de uso. Fale com a administração.'
  }
}

/** pt-BR message for any error coming from an API call. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const problem = error.problem
    if (problem?.code === 'validation_failed') {
      const fields = problem.errors?.map((e) => `${e.field}: ${e.message}`).join('; ')
      return fields ? `Confira os campos — ${fields}.` : 'Confira os campos do formulário.'
    }
    if (problem?.code === 'quota_exceeded') return quotaMessage(problem)
    if (problem && MESSAGES[problem.code]) return MESSAGES[problem.code]
    return problem?.detail ?? `O servidor respondeu com erro (HTTP ${error.status}).`
  }
  if (error instanceof TypeError) return 'Sem conexão com o servidor. Confira a rede e tente de novo.'
  return error instanceof Error ? error.message : 'Algo deu errado.'
}
