import { useEffect, useRef, useState } from 'react'
import { useBridge } from '../bridge/bridge'
import type { AppState } from '../bridge/types'
import { Address } from '../screens/Address'
import { Detail } from '../screens/Detail'
import { Home } from '../screens/Home'
import { Recording } from '../screens/Recording'
import { ScanCode } from '../screens/ScanCode'
import { Server } from '../screens/Server'
import { Settings } from '../screens/Settings'
import { SignIn } from '../screens/SignIn'
import { deviceTag, setLocale } from '../i18n'
import { Brand } from './Brand'
import { useRoute } from './routes'
import { useAppState } from './state'
import { applyInsets, followSystemTheme } from './theme'

/**
 * The app's shell: the screen comes from the `AppState` (connection, session) and the hash route.
 * The launcher icon's record-now shortcut is consumed on open and every time the app becomes visible
 * again: in the `conectado` phase, with no recording nor sheet, it goes to Home and runs the Gravar
 * button's flow; with a recording running, its screen is already there; in another phase, it is
 * dropped (the phase's screen says what is missing).
 */
export default function App() {
  const bridge = useBridge()
  const state = useAppState()
  const [route, go] = useRoute()
  const [recordRequest, setRecordRequest] = useState(0)
  // The state and navigation of the latest render, for the shortcut's reply, which arrives later.
  const latest = useRef({ state, go })
  useEffect(() => {
    latest.current = { state, go }
  })
  const opened = state !== null

  useEffect(() => {
    const report = () => { void bridge.reportDeviceLocale(deviceTag()).catch(() => {}) }
    report()
    window.addEventListener('languagechange', report)
    return () => window.removeEventListener('languagechange', report)
  }, [bridge])

  useEffect(() => {
    if (state?.locale) setLocale(state.locale)
  }, [state?.locale])

  useEffect(() => {
    if (!opened) return
    const consume = () =>
      bridge
        .consumeShortcut()
        .then((record) => {
          const { state: now, go: goTo } = latest.current
          if (!record || now?.conexao.fase !== 'conectado' || now.sessao || now.folha) return
          goTo('/')
          setRecordRequest((n) => n + 1)
        })
        .catch(() => {})
    void consume()
    const onReturn = () => {
      if (document.visibilityState === 'visible') void consume()
    }
    document.addEventListener('visibilitychange', onReturn)
    return () => document.removeEventListener('visibilitychange', onReturn)
  }, [bridge, opened])

  useEffect(() => followSystemTheme(), [])

  useEffect(() => {
    bridge
      .insets()
      .then(applyInsets)
      .catch(() => {})
    const onChange = () => bridge.visibility(document.visibilityState === 'visible').catch(() => {})
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [bridge])

  return (
    <main className="m-app">
      {state ? <Screen state={state} route={route} go={go} recordRequest={recordRequest} /> : <Opening />}
    </main>
  )
}

function Screen({
  state,
  route,
  go,
  recordRequest,
}: {
  state: AppState
  route: string
  go: (route: string) => void
  recordRequest: number
}) {
  // A recording (or the saved-recording sheet) in progress stays on screen, whatever the
  // connection phase: a 401 in the middle of the recording does not take Pausar, Marcador and Parar away.
  if (state.sessao || state.folha) return <Recording state={state} />
  const connection = state.conexao
  switch (connection.fase) {
    case 'sem_servidor':
      if (route === '/scan-code') return <ScanCode go={go} backTo="/server" />
      if (route === '/server/address') return <Address confirm={null} go={go} />
      return <Server go={go} />
    case 'confirmar_ca':
      return <Address confirm={connection} go={go} />
    case 'sem_credencial':
      if (route === '/scan-code') return <ScanCode go={go} backTo="/sign-in" />
      return <SignIn server={connection.servidor} reason={connection.motivo} go={go} />
    case 'conectado':
      if (route === '/settings') return <Settings go={go} freeSpace={state.espaco_livre} />
      if (route.startsWith('/recording/')) return <Detail id={decodeURIComponent(route.slice(11))} go={go} />
      return <Home state={state} go={go} recordRequest={recordRequest} />
  }
}

function Opening() {
  return (
    <div className="m-body">
      <div className="m-top">
        <Brand />
      </div>
    </div>
  )
}
