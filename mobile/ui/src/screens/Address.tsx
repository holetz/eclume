import { useState, type FormEvent } from 'react'
import { Back } from '../app/Back'
import { errorMessage, useBridge } from '../bridge/bridge'

/**
 * The typed address and the check of the CA fingerprint (TOFU). The check also applies to a server
 * found through mDNS, whose announcement is not authenticated.
 */
export function Address({
  confirm,
  go,
}: {
  /** The downloaded CA waiting for "Confiar"; without it, the address field. */
  confirm: { url: string; impressao: string } | null
  go: (route: string) => void
}) {
  const bridge = useBridge()
  const [address, setAddress] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    run(() => bridge.connectAddress(address))
  }

  if (confirm) {
    return (
      <div className="m-body">
        <Back label="Servidores" onBack={() => run(() => bridge.cancelCa())} />
        <div className="m-section gap-2">
          <h1 className="m-title">Confira o servidor</h1>
          <p className="no-margin text-15">
            Compare os blocos abaixo com os da web, em Minhas configurações → App móvel. Se forem os
            mesmos, o celular passa a confiar só neste servidor.
          </p>
          <div className="code-block">
            <span>{new URL(confirm.url).host}</span>
          </div>
        </div>
        <div className="m-section m-fill">
          <span className="kicker">Impressão digital</span>
          <p className="fingerprint mono" aria-label="Impressão digital do certificado">
            {confirm.impressao}
          </p>
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="m-section two-columns">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => run(() => bridge.trustCa())}
          >
            Confiar
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            onClick={() => run(() => bridge.cancelCa())}
          >
            Cancelar
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="m-body">
      <Back label="Servidores" onBack={() => go('/server')} />
      <form className="m-section m-fill gap-4 align-top" onSubmit={submit}>
        <h1 className="m-title">Digite o endereço</h1>
        <div className="field">
          <label htmlFor="address">Endereço do servidor</label>
          <input
            id="address"
            className="input"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            placeholder="servidor.local:8443"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
        </div>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <button
          type="submit"
          className="btn btn-primary button-start"
          disabled={busy || !address.trim()}
        >
          {busy ? 'Conectando…' : 'Continuar'}
        </button>
      </form>
    </div>
  )
}
