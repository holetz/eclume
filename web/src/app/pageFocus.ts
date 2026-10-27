// The current route after the first route change inside the frame (`ShellFrame`), or `null`
// before it and outside the frame: `PageHead` moves focus to the title when it changes. The first
// load and a search-only change do not change the value, so they do not move focus.
import { createContext, useContext } from 'react'

export const NavigatedPathContext = createContext<string | null>(null)

export function useNavigatedPath(): string | null {
  return useContext(NavigatedPathContext)
}
