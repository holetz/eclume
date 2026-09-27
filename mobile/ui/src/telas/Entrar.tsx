import { useState, type FormEvent } from 'react'
import { Voltar } from '../app/Voltar'
import { mensagemDeErro, usePonte } from '../ponte/ponte'
import type { Servidor } from '../ponte/tipos'

/** Entrar com a conta da web; o servidor já está fixado. */
export function Entrar({ servidor, ir }: { servidor: Servidor; ir: (rota: string) => void }) {
  const ponte = usePonte()
  const [email, setEmail] = useState('')
  const [senha, setSenha] = useState('')
  const [erro, setErro] = useState<string | null>(null)
  const [ocupado, setOcupado] = useState(false)

  async function enviar(evento: FormEvent) {
    evento.preventDefault()
    setOcupado(true)
    setErro(null)
    try {
      await ponte.entrar(email, senha)
    } catch (e) {
      setErro(mensagemDeErro(e))
    } finally {
      setOcupado(false)
    }
  }

  async function trocarDeServidor() {
    await ponte.sair()
    ir('/servidor')
  }

  return (
    <div className="m-body">
      <Voltar rotulo="Servidores" aoVoltar={trocarDeServidor} />
      <div className="m-section" style={{ gap: 8 }}>
        <h1 className="m-title">Entrar</h1>
        <p style={{ margin: 0, fontSize: 15 }}>Use a conta que você tem na web.</p>
        <div className="code-block">
          <span>{new URL(servidor.url).host}</span>
        </div>
      </div>
      <form className="m-section m-fill" style={{ gap: 16, alignContent: 'start' }} onSubmit={enviar}>
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
          <label htmlFor="senha">Senha</label>
          <input
            id="senha"
            className="input"
            type="password"
            autoComplete="current-password"
            value={senha}
            onChange={(e) => setSenha(e.target.value)}
          />
        </div>
        {erro && (
          <p className="erro" role="alert">
            {erro}
          </p>
        )}
        <button
          type="submit"
          className="btn btn-primary"
          style={{ justifyContent: 'flex-start' }}
          disabled={ocupado || !email.trim() || !senha}
        >
          {ocupado ? 'Entrando…' : 'Entrar'}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          style={{ justifyContent: 'flex-start' }}
          onClick={() => ir('/ler-codigo')}
        >
          Ler um código da web
        </button>
      </form>
    </div>
  )
}
