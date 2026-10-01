import { useEffect, useState } from 'react'
import { Voltar } from '../app/Voltar'
import { mensagemDeErro, usePonte } from '../ponte/ponte'

/**
 * Lê o QR de pareamento da web. A câmera fica atrás do WebView (`windowed`): a tela deixa o
 * fundo transparente e desenha o `.viewfinder` do DS por cima. O texto lido não é confiável: o
 * núcleo o valida (`parse_pair_url`) antes de qualquer rede.
 */
export function LerCodigo({ ir, voltarPara }: { ir: (rota: string) => void; voltarPara: string }) {
  const ponte = usePonte()
  const [erro, setErro] = useState<string | null>(null)
  const [lendo, setLendo] = useState(true)
  const [rodada, setRodada] = useState(0)

  useEffect(() => {
    let ativo = true
    document.documentElement.classList.add('lendo-codigo')
    ponte
      .lerCodigo()
      .then((texto) => (texto === null ? undefined : ponte.parear(texto)))
      .catch((e) => ativo && setErro(mensagemDeErro(e)))
      .finally(() => ativo && setLendo(false))
    return () => {
      ativo = false
      document.documentElement.classList.remove('lendo-codigo')
      ponte.cancelarLeitura().catch(() => {})
    }
  }, [ponte, rodada])

  function lerDeNovo() {
    setErro(null)
    setLendo(true)
    setRodada((n) => n + 1)
  }

  return (
    <div className="m-body">
      <Voltar rotulo="Servidores" aoVoltar={() => ir(voltarPara)} />
      <div className="m-section gap-2">
        <h1 className="m-title">Leia o código</h1>
      </div>
      <div className="viewfinder margem-lateral" aria-label="Câmera">
        {lendo ? '' : 'câmera'}
      </div>
      <div className="m-section m-fill">
        {erro && (
          <div className="stack-curta">
            <p className="erro" role="alert">
              {erro}
            </p>
            <button type="button" className="btn btn-secondary" onClick={lerDeNovo}>
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
