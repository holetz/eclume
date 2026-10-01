import { useState, type FormEvent } from 'react'
import { Voltar } from '../app/Voltar'
import { mensagemDeErro, usePonte } from '../ponte/ponte'

/**
 * O endereço digitado e a conferência da impressão digital da CA (TOFU). A conferência também
 * vale para um servidor achado pelo mDNS, cujo anúncio não é autenticado.
 */
export function Endereco({
  conferir,
  ir,
}: {
  /** A CA baixada que espera "Confiar"; sem ela, o campo do endereço. */
  conferir: { url: string; impressao: string } | null
  ir: (rota: string) => void
}) {
  const ponte = usePonte()
  const [endereco, setEndereco] = useState('')
  const [erro, setErro] = useState<string | null>(null)
  const [ocupado, setOcupado] = useState(false)

  async function rodar(acao: () => Promise<void>) {
    setOcupado(true)
    setErro(null)
    try {
      await acao()
    } catch (e) {
      setErro(mensagemDeErro(e))
    } finally {
      setOcupado(false)
    }
  }

  function enviar(evento: FormEvent) {
    evento.preventDefault()
    rodar(() => ponte.conectarEndereco(endereco))
  }

  if (conferir) {
    return (
      <div className="m-body">
        <Voltar rotulo="Servidores" aoVoltar={() => rodar(() => ponte.cancelarCa())} />
        <div className="m-section gap-2">
          <h1 className="m-title">Confira o servidor</h1>
          <p className="sem-margem texto-15">
            Compare os blocos abaixo com os da web, em Minhas configurações → App móvel. Se forem os
            mesmos, o celular passa a confiar só neste servidor.
          </p>
          <div className="code-block">
            <span>{new URL(conferir.url).host}</span>
          </div>
        </div>
        <div className="m-section m-fill">
          <span className="kicker">Impressão digital</span>
          <p className="impressao mono" aria-label="Impressão digital do certificado">
            {conferir.impressao}
          </p>
          {erro && (
            <p className="erro" role="alert">
              {erro}
            </p>
          )}
        </div>
        <div className="m-section duas-colunas">
          <button
            type="button"
            className="btn btn-primary"
            disabled={ocupado}
            onClick={() => rodar(() => ponte.confiarCa())}
          >
            Confiar
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={ocupado}
            onClick={() => rodar(() => ponte.cancelarCa())}
          >
            Cancelar
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="m-body">
      <Voltar rotulo="Servidores" aoVoltar={() => ir('/servidor')} />
      <form className="m-section m-fill gap-4 alinha-topo" onSubmit={enviar}>
        <h1 className="m-title">Digite o endereço</h1>
        <div className="field">
          <label htmlFor="endereco">Endereço do servidor</label>
          <input
            id="endereco"
            className="input"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            placeholder="192.168.15.199:8443"
            value={endereco}
            onChange={(e) => setEndereco(e.target.value)}
          />
        </div>
        {erro && (
          <p className="erro" role="alert">
            {erro}
          </p>
        )}
        <button
          type="submit"
          className="btn btn-primary botao-inicio"
          disabled={ocupado || !endereco.trim()}
        >
          {ocupado ? 'Conectando…' : 'Continuar'}
        </button>
      </form>
    </div>
  )
}
