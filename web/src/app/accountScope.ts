// What belongs to one account does not cross over to another in the same tab: the user's data cache and
// the summary drafts kept in `sessionStorage` (`eclume-resumo-rascunho:<id>`). The admin panel has its
// own session and lives under `['admin']`, outside this cleanup.
import type { QueryClient, QueryKey } from '@tanstack/react-query'

const ACCOUNT_KEY = 'eclume-conta'
const DRAFT_PREFIX = 'eclume-resumo-rascunho:'

/** Removes the user queries from the cache (everything outside `['admin']`), except the one in `keep`. */
export function clearUserQueries(client: QueryClient, keep?: QueryKey): void {
  const kept = keep && JSON.stringify(keep)
  client.removeQueries({
    predicate: (query) => query.queryKey[0] !== 'admin' && JSON.stringify(query.queryKey) !== kept,
  })
}

/**
 * On sign-in (login, signup or the cookie session): if the account is not the last one that used this
 * tab, clears the user cache (except the session just read, in `sessionKey`) and the tab's drafts, and
 * remembers the new account. The same account coming back finds its drafts again.
 */
export function enterAccount(client: QueryClient, userId: string, sessionKey: QueryKey): void {
  let previous: string | null
  try {
    previous = window.sessionStorage.getItem(ACCOUNT_KEY)
    // The tab's first account: no other account's data to clear (the guard marks the account before
    // any draft is written).
    if (previous === null) window.sessionStorage.setItem(ACCOUNT_KEY, userId)
  } catch {
    // Without storage there is no saved draft and no way to know the previous account.
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
    // Best effort: the cache, which is what shows data on screen, has already been cleared.
  }
}
