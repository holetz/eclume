import { useEffect, useState } from 'react'
import { Marca } from '../app/Marca'
import { mensagemDeErro, usePonte } from '../ponte/ponte'
import type { Achado } from '../ponte/tipos'

/** Quanto a procura na rede dura. */
export const SEGUNDOS_DE_PROCURA = 10

/** Primeira execução: acha o servidor na rede Wi-Fi pelo mDNS. */
export function Servidor({ ir }: { ir: (rota: string) => void }) {
  const ponte = usePonte()
  const [achados, setAchados] = useState<Achado[]>([])
  const [procurando, setProcurando] = useState(true)
  const [erro, setErro] = useState<string | null>(null)
  const [conectando, setConectando] = useState<string | null>(null)

  const [rodada, setRodada] = useState(0)

  useEffect(() => {
    let ativo = true
    ponte
      .descobrir(SEGUNDOS_DE_PROCURA)
      .then((lista) => ativo && setAchados(lista))
      .catch((e) => ativo && setErro(mensagemDeErro(e)))
      .finally(() => ativo && setProcurando(false))
    return () => {
      ativo = false
    }
  }, [ponte, rodada])

  function procurar() {
    setProcurando(true)
    setErro(null)
    setRodada((n) => n + 1)
  }

  async function conectar(achado: Achado) {
    setConectando(achado.url)
    setErro(null)
    try {
      await ponte.conectarDescoberto(achado.url, achado.ca_sha256)
    } catch (e) {
      setErro(mensagemDeErro(e))
    } finally {
      setConectando(null)
    }
  }

  return (
    <div className="m-body">
      <div className="m-section topo-7 gap-2">
        <Marca grande />
        <h1 className="m-title margem-topo-5">
          Encontre o seu servidor
        </h1>
        <p className="sem-margem texto-15">O celular procura o eclume nesta rede Wi‑Fi.</p>
      </div>
      <div className="m-section m-fill">
        <div className="linha-entre">
          <span className="kicker">Encontrado nesta rede</span>
          {procurando ? (
            <span className="badge badge-progress">Procurando…</span>
          ) : (
            <button type="button" className="btn btn-ghost btn-sm" onClick={procurar}>
              Procurar de novo
            </button>
          )}
        </div>
        {achados.length > 0 ? (
          <ul className="m-rows">
            {achados.map((achado) => (
              <li className="m-row" key={achado.url}>
                <span className="m-row-title">{achado.nome}</span>
                <span className="m-row-sub">{new URL(achado.url).host}</span>
                <span className="m-row-end">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={conectando !== null}
                    onClick={() => conectar(achado)}
                  >
                    {conectando === achado.url ? 'Conectando…' : 'Conectar'}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          !procurando && (
            <p className="text-muted sem-margem texto-14">
              Nenhum servidor respondeu. Confira se o celular está no Wi‑Fi do servidor, leia o código
              da web ou digite o endereço.
            </p>
          )
        )}
        {erro && (
          <p className="erro" role="alert">
            {erro}
          </p>
        )}
      </div>
      <div className="m-section gap-2">
        <button
          type="button"
          className="btn btn-secondary botao-inicio"
          onClick={() => ir('/ler-codigo')}
        >
          Ler um código da web
        </button>
        <button
          type="button"
          className="btn btn-ghost botao-inicio"
          onClick={() => ir('/servidor/endereco')}
        >
          Digitar o endereço
        </button>
      </div>
    </div>
  )
}
