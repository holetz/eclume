// Keeps the UI language on the session: the account's `locale` once `/me` answers, else the browser
// language (before login, after logout, or an account that never chose one). It only observes the
// `/me` query, never fetches it: public pages and the admin panel make no call to `/me`.
import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import type { Schemas } from '../api/client'
import { ME_KEY } from '../app/session'
import { setLocale } from './index'
import { browserLocale, normalize } from './locale'

export function LocaleSync() {
  const me = useQuery<Schemas['Me'] | null>({ queryKey: ME_KEY, enabled: false })
  const account = me.data?.user.locale ?? null
  const settled = me.data !== undefined
  useEffect(() => {
    if (settled) void setLocale(normalize(account) ?? browserLocale())
  }, [account, settled])
  return null
}
