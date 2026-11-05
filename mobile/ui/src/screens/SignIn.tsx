import { useState, type FormEvent } from 'react'
import { Back } from '../app/Back'
import { errorMessage, useBridge } from '../bridge/bridge'
import type { Server } from '../bridge/types'

/** Signs in with the web account; the server is already pinned. `reason`: why the credential went away. */
export function SignIn({
  server,
  reason,
  go,
}: {
  server: Server
  reason?: string
  go: (route: string) => void
}) {
  const bridge = useBridge()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await bridge.signIn(email, password)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  async function switchServer() {
    await bridge.signOut()
    go('/server')
  }

  return (
    <div className="m-body">
      <Back label="Servidores" onBack={switchServer} />
      <div className="m-section gap-2">
        <h1 className="m-title">Entrar</h1>
        <p className="no-margin text-15">Use a conta que você tem na web.</p>
        <div className="code-block">
          <span>{new URL(server.url).host}</span>
        </div>
      </div>
      {reason && (
        <div className="m-section">
          <div className="alert alert-warning">
            <span>{reason}</span>
          </div>
        </div>
      )}
      <form className="m-section m-fill gap-4 align-top" onSubmit={submit}>
        <div className="field">
          <label htmlFor="email">E-mail</label>
          <input
            id="email"
            className="input"
            type="email"
            autoComplete="username"
            autoCapitalize="none"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="password">Senha</label>
          <input
            id="password"
            className="input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
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
          disabled={busy || !email.trim() || !password}
        >
          {busy ? 'Entrando…' : 'Entrar'}
        </button>
        <button
          type="button"
          className="btn btn-ghost button-start"
          onClick={() => go('/scan-code')}
        >
          Ler um código da web
        </button>
      </form>
    </div>
  )
}
