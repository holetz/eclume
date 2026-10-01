import { useEffect, useRef, useState } from 'react'
import { tamanho } from '../app/formatos'
import { gravar as fluxoDeGravar, gravarDepoisDaBateria, type PassoDoGravar, SEM_MICROFONE } from '../app/gravar'
import { IconeAjustes } from '../app/Icones'
import { Marca } from '../app/Marca'
import { mensagemDeErro, usePonte } from '../ponte/ponte'
import type { Aparelho, EstadoApp, GravacaoLocal } from '../ponte/tipos'
import { FaixaDeRede } from './FaixaDeRede'
import { ListaDoCelular } from './ListaDoCelular'

/** O resumo à direita de "Neste celular". */
function resumo(estado: EstadoApp): string {
  if (estado.pendentes === 0) return 'Tudo sincronizado'
  if (estado.rede.estado === 'away') return 'Sincroniza no Wi‑Fi do servidor'
  return estado.pendentes === 1 ? '1 aguardando' : `${estado.pendentes} aguardando`
}

/**
 * Início: a faixa de rede, o botão Gravar e as gravações deste celular. Cada novo `pedidoDeGravar`
 * (o atalho "Gravar agora" do ícone) roda o mesmo fluxo do botão, quando o aparelho já foi lido.
 */
export function Inicio({
  estado,
  ir,
  pedidoDeGravar = 0,
}: {
  estado: EstadoApp
  ir: (rota: string) => void
  pedidoDeGravar?: number
}) {
  const ponte = usePonte()
  const [gravacoes, setGravacoes] = useState<GravacaoLocal[]>([])
  const [erro, setErro] = useState<string | null>(null)
  const [ocupado, setOcupado] = useState(false)
  const [semMicrofone, setSemMicrofone] = useState(false)
  const [aparelho, setAparelho] = useState<Aparelho | null>(null)
  const [aparelhoLido, setAparelhoLido] = useState(false)
  const [explicandoBateria, setExplicandoBateria] = useState(false)
  const pedidoAtendido = useRef(0)

  useEffect(() => {
    let ativo = true
    ponte
      .aparelho()
      .then((lido) => ativo && setAparelho(lido))
      .catch(() => {})
      .finally(() => ativo && setAparelhoLido(true))
    return () => {
      ativo = false
    }
  }, [ponte])

  // A lista acompanha o estado: a cada mudança de pendentes ou de rede, lê de novo.
  const chave = `${estado.pendentes}|${estado.rede.estado}|${estado.folha?.id ?? ''}`
  useEffect(() => {
    let ativo = true
    ponte
      .gravacoes()
      .then((lista) => ativo && setGravacoes(lista))
      .catch(() => {})
    return () => {
      ativo = false
    }
  }, [ponte, chave])

  function mostrar(passo: PassoDoGravar) {
    if (passo.passo === 'sem_microfone') {
      setSemMicrofone(true)
      setErro(SEM_MICROFONE)
    } else if (passo.passo === 'explicar_bateria') {
      setExplicandoBateria(true)
    } else if (passo.passo === 'erro') {
      setErro(passo.mensagem)
    }
  }

  async function gravar() {
    setOcupado(true)
    setErro(null)
    setSemMicrofone(false)
    const passo = await fluxoDeGravar(ponte, aparelho, (notificacoes) =>
      setAparelho((atual) => atual && { ...atual, notificacoes }),
    )
    mostrar(passo)
    setOcupado(false)
  }

  async function seguirDaBateria(pedir: boolean) {
    setExplicandoBateria(false)
    setOcupado(true)
    const resultado = await gravarDepoisDaBateria(ponte, pedir)
    if (resultado.aparelho) setAparelho(resultado.aparelho)
    mostrar(resultado.passo)
    setOcupado(false)
  }

  // O atalho "Gravar agora": o mesmo fluxo do botão, uma vez por pedido.
  useEffect(() => {
    if (!aparelhoLido || pedidoDeGravar <= pedidoAtendido.current) return
    pedidoAtendido.current = pedidoDeGravar
    void gravar()
    // `gravar` lê o aparelho deste render; o pedido é o gatilho.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pedidoDeGravar, aparelhoLido])

  async function abrirConfiguracoesDoApp() {
    try {
      await ponte.abrirConfiguracoesDoApp()
    } catch (e) {
      setErro(mensagemDeErro(e))
    }
  }

  async function excluirSincronizadas() {
    try {
      await ponte.excluirSincronizadas()
      setGravacoes(await ponte.gravacoes())
    } catch (e) {
      setErro(mensagemDeErro(e))
    }
  }

  const armazenamento = estado.avisos.armazenamento
  return (
    <div className="m-body">
      <div className="m-top">
        <Marca />
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          aria-label="Configurações"
          onClick={() => ir('/configuracoes')}
        >
          <IconeAjustes />
        </button>
      </div>
      <FaixaDeRede rede={estado.rede} pendentes={estado.pendentes} />
      {aparelho && !aparelho.notificacoes && (
        <div className="alert alert-warning alerta-no-topo" role="status">
          <span className="alert-title">Notificações bloqueadas</span>
          <span>Sem elas, a gravação não aparece na tela bloqueada e você não fica sabendo se ela parar.</span>
          <button
            type="button"
            className="btn btn-secondary btn-sm alinha-inicio margem-topo-2"
            onClick={abrirConfiguracoesDoApp}
          >
            Abrir configurações do app
          </button>
        </div>
      )}
      {armazenamento && (
        <div className="alert alert-warning alerta-no-topo" role="status">
          <span className="alert-title">Armazenamento quase cheio</span>
          <span>{armazenamento.restante.replace(/^cerca/, 'Cerca')} de gravação.</span>
          {armazenamento.sincronizadas_bytes > 0 && (
            <button
              type="button"
              className="btn btn-secondary btn-sm alinha-inicio margem-topo-2"
              onClick={excluirSincronizadas}
            >
              Excluir sincronizadas · {tamanho(armazenamento.sincronizadas_bytes)}
            </button>
          )}
        </div>
      )}
      <div className="m-section">
        <button type="button" className="m-rec" aria-pressed="false" disabled={ocupado} onClick={gravar}>
          <span>
            <span className="m-rec-label">Gravar</span>
            <span className="m-rec-sub">Continua gravando com a tela bloqueada</span>
          </span>
        </button>
        {explicandoBateria && (
          <div className="alert alert-info" role="alertdialog" aria-label="Gravar com a tela bloqueada">
            <span className="alert-title">Gravar com a tela bloqueada</span>
            <span>
              A otimização de bateria do Android pode parar a gravação com a tela apagada. Permita que o eclume
              funcione em segundo plano.
            </span>
            <div className="duas-colunas margem-topo-2">
              <button type="button" className="btn btn-primary" onClick={() => seguirDaBateria(true)}>
                Permitir
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => seguirDaBateria(false)}>
                Agora não
              </button>
            </div>
          </div>
        )}
        {erro && (
          <p className="erro" role="alert">
            {erro}
          </p>
        )}
        {semMicrofone && (
          <button type="button" className="btn btn-secondary" onClick={abrirConfiguracoesDoApp}>
            Abrir configurações do app
          </button>
        )}
      </div>
      <ListaDoCelular gravacoes={gravacoes} resumo={resumo(estado)} abrir={(id) => ir(`/gravacao/${id}`)} />
    </div>
  )
}
