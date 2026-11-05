import { useEffect, useState } from 'react'
import { useBridge } from '../bridge/bridge'
import type { AppState } from '../bridge/types'

/** The current `AppState`: read once and then through the `estado` event. */
export function useAppState(): AppState | null {
  const bridge = useBridge()
  const [state, setState] = useState<AppState | null>(null)

  useEffect(() => {
    let active = true
    let cancel: (() => void) | undefined
    bridge
      .state()
      .then((read) => active && setState(read))
      .catch(() => {})
    bridge.onState((next) => active && setState(next)).then((fn) => {
      if (active) cancel = fn
      else fn()
    })
    return () => {
      active = false
      cancel?.()
    }
  }, [bridge])

  return state
}
