import { useCallback, useEffect, useState } from 'react'

function readRoute(): string {
  return window.location.hash.replace(/^#/, '') || '/'
}

/** The hash route (`#/settings`) and the function that navigates. */
export function useRoute(): [string, (route: string) => void] {
  const [route, setRoute] = useState(readRoute)

  useEffect(() => {
    const onChange = () => setRoute(readRoute())
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  const go = useCallback((target: string) => {
    window.location.hash = target
    setRoute(target)
  }, [])

  return [route, go]
}
