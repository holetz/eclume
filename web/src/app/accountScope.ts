// O que é de uma conta não atravessa para outra na mesma aba: o cache de dados do usuário e os
// rascunhos de resumo guardados no `sessionStorage` (`eclume-resumo-rascunho:<id>`). O painel admin
// tem sessão própria e fica sob `['admin']`, fora desta limpeza.
import type { QueryClient, QueryKey } from '@tanstack/react-query'

const ACCOUNT_KEY = 'eclume-conta'
const DRAFT_PREFIX = 'eclume-resumo-rascunho:'

/** Remove do cache as consultas de usuário (tudo fora de `['admin']`), menos a de `keep`. */
export function clearUserQueries(client: QueryClient, keep?: QueryKey): void {
  const kept = keep && JSON.stringify(keep)
  client.removeQueries({
    predicate: (query) => query.queryKey[0] !== 'admin' && JSON.stringify(query.queryKey) !== kept,
  })
}

/**
 * Ao entrar (login, cadastro ou a sessão do cookie): se a conta não é a última que usou esta aba,
 * apaga o cache de usuário (menos a sessão recém-lida, em `sessionKey`) e os rascunhos da aba, e
 * lembra a conta nova. A mesma conta que volta reencontra os rascunhos.
 */
export function enterAccount(client: QueryClient, userId: string, sessionKey: QueryKey): void {
  let previous: string | null
  try {
    previous = window.sessionStorage.getItem(ACCOUNT_KEY)
    // A primeira conta da aba: nada de outra conta para apagar (o guarda marca a conta antes de
    // qualquer rascunho ser escrito).
    if (previous === null) window.sessionStorage.setItem(ACCOUNT_KEY, userId)
  } catch {
    // Sem armazenamento não há rascunho guardado nem como saber a conta anterior.
    return
  }
  if (previous === null || previous === userId) return
  clearUserQueries(client, sessionKey)
  try {
    const storage = window.sessionStorage
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index))
    for (const key of keys) if (key?.startsWith(DRAFT_PREFIX)) storage.removeItem(key)
    storage.setItem(ACCOUNT_KEY, userId)
  } catch {
    // Melhor esforço: o cache, que é o que mostra dado na tela, já foi limpo.
  }
}
