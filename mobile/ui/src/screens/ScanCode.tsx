import { useEffect, useState } from 'react'
import { Back } from '../app/Back'
import { errorMessage, useBridge } from '../bridge/bridge'

/**
 * Reads the web's pairing QR. The camera sits behind the WebView (`windowed`): the screen makes the
 * background transparent and draws the DS's `.viewfinder` on top. The text read is not trusted: the
 * core validates it (`parse_pair_url`) before any network.
 */
export function ScanCode({ go, backTo }: { go: (route: string) => void; backTo: string }) {
  const bridge = useBridge()
  const [error, setError] = useState<string | null>(null)
  const [reading, setReading] = useState(true)
  const [round, setRound] = useState(0)

  useEffect(() => {
    let active = true
    document.documentElement.classList.add('scanning-code')
    bridge
      .scanCode()
      .then((text) => (text === null ? undefined : bridge.pair(text)))
      .catch((e) => active && setError(errorMessage(e)))
      .finally(() => active && setReading(false))
    return () => {
      active = false
      document.documentElement.classList.remove('scanning-code')
      bridge.cancelScan().catch(() => {})
    }
  }, [bridge, round])

  function readAgain() {
    setError(null)
    setReading(true)
    setRound((n) => n + 1)
  }

  return (
    <div className="m-body">
      <Back label="Servidores" onBack={() => go(backTo)} />
      <div className="m-section gap-2">
        <h1 className="m-title">Leia o código</h1>
      </div>
      <div className="viewfinder margin-x" aria-label="Câmera">
        {reading ? '' : 'câmera'}
      </div>
      <div className="m-section m-fill">
        {error && (
          <div className="stack-tight">
            <p className="error-text" role="alert">
              {error}
            </p>
            <button type="button" className="btn btn-secondary" onClick={readAgain}>
              Tentar de novo
            </button>
          </div>
        )}
        <ol className="steps">
          <li>
            <strong>Abra a web</strong>
            <span>Vá em Minhas configurações → App móvel.</span>
          </li>
          <li>
            <strong>Aponte a câmera para o código</strong>
            <span>O celular se conecta e entra. O código vale 10 minutos.</span>
          </li>
        </ol>
      </div>
    </div>
  )
}
