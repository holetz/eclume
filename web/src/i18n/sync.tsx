// Keeps the UI language on the session: the account's `locale` once `/me` answers, else the browser
// language (before login, after logout, or an account that never chose one). It only observes the
// `/me` query, never fetches it: public pages and the admin panel make no call to `/me`.
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useSyncExternalStore } from 'react'
import type { Schemas } from '../api/client'
import { ME_KEY } from '../app/session'
import { activeLocale, setLocale } from './index'
import { browserLocale, normalize } from './locale'

export function LocaleSync() {
  // Reads the cache directly: a `useQuery` here would register a query with no `queryFn`, which the
  // invalidation after a locale change then tries to run.
  const client = useQueryClient()
  const me = useSyncExternalStore(
    (notify) => client.getQueryCache().subscribe(notify),
    () => client.getQueryData<Schemas['Me'] | null>(ME_KEY),
  )
  const account = me?.user.locale ?? null
  const settled = me !== undefined
  useEffect(() => {
    if (!settled) return
    // Only a real change: a switch re-renders every translated screen, and a session ending
    // (logout, deleted account) must reach its own navigation first.
    const locale = normalize(account) ?? browserLocale()
    if (locale !== activeLocale()) void setLocale(locale)
  }, [account, settled])
  return null
}
