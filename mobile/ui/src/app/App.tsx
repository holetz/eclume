import { useEffect, useRef, useState } from 'react'
import { usePonte } from '../ponte/ponte'
import type { EstadoApp } from '../ponte/tipos'
import { Configuracoes } from '../telas/Configuracoes'
import { Detalhe } from '../telas/Detalhe'
import { Endereco } from '../telas/Endereco'
import { Entrar } from '../telas/Entrar'
import { Gravando } from '../telas/Gravando'
import { Inicio } from '../telas/Inicio'
import { LerCodigo } from '../telas/LerCodigo'
import { Servidor } from '../telas/Servidor'
import { useEstadoApp } from './estado'
import { Marca } from './Marca'
import { useRota } from './rotas'
import { aplicarRecortes, seguirTemaDoSistema } from './tema'

/**
 * A casca do app: a tela sai do `EstadoApp` (conexão, sessão) e da rota do hash. O atalho "Gravar
 * agora" do ícone é consumido na abertura e a cada volta à visibilidade: na fase `conectado`, sem
 * gravação nem folha, ele leva ao Início e roda o fluxo do botão Gravar; com uma gravação em curso,
 * a tela dela já está; em outra fase, é descartado (a tela da fase diz o que falta).
 */
export default function App() {
  const ponte = usePonte()
  const estado = useEstadoApp()
  const [rota, ir] = useRota()
  const [pedidoDeGravar, setPedidoDeGravar] = useState(0)
  // O estado e a navegação do render mais recente, para a resposta do atalho, que chega depois.
  const atual = useRef({ estado, ir })
  useEffect(() => {
    atual.current = { estado, ir }
  })
  const aberto = estado !== null

  useEffect(() => {
    if (!aberto) return
    const consumir = () =>
      ponte
        .consumirAtalho()
        .then((gravar) => {
          const { estado: agora, ir: irPara } = atual.current
          if (!gravar || agora?.conexao.fase !== 'conectado' || agora.sessao || agora.folha) return
          irPara('/')
          setPedidoDeGravar((n) => n + 1)
        })
        .catch(() => {})
    void consumir()
    const aoVoltar = () => {
      if (document.visibilityState === 'visible') void consumir()
    }
    document.addEventListener('visibilitychange', aoVoltar)
    return () => document.removeEventListener('visibilitychange', aoVoltar)
  }, [ponte, aberto])

  useEffect(() => seguirTemaDoSistema(), [])

  useEffect(() => {
    ponte
      .recortes()
      .then(aplicarRecortes)
      .catch(() => {})
    const aoMudar = () => ponte.visibilidade(document.visibilityState === 'visible').catch(() => {})
    document.addEventListener('visibilitychange', aoMudar)
    return () => document.removeEventListener('visibilitychange', aoMudar)
  }, [ponte])

  return (
    <main className="m-app">
      {estado ? <Tela estado={estado} rota={rota} ir={ir} pedidoDeGravar={pedidoDeGravar} /> : <Abrindo />}
    </main>
  )
}

function Tela({
  estado,
  rota,
  ir,
  pedidoDeGravar,
}: {
  estado: EstadoApp
  rota: string
  ir: (rota: string) => void
  pedidoDeGravar: number
}) {
  // Uma gravação (ou a folha "Gravação salva") em curso fica na tela, seja qual for a fase da
  // conexão: um 401 no meio da gravação não tira Pausar, Marcador e Parar.
  if (estado.sessao || estado.folha) return <Gravando estado={estado} />
  const conexao = estado.conexao
  switch (conexao.fase) {
    case 'sem_servidor':
      if (rota === '/ler-codigo') return <LerCodigo ir={ir} voltarPara="/servidor" />
      if (rota === '/servidor/endereco') return <Endereco conferir={null} ir={ir} />
      return <Servidor ir={ir} />
    case 'confirmar_ca':
      return <Endereco conferir={conexao} ir={ir} />
    case 'sem_credencial':
      if (rota === '/ler-codigo') return <LerCodigo ir={ir} voltarPara="/entrar" />
      return <Entrar servidor={conexao.servidor} motivo={conexao.motivo} ir={ir} />
    case 'conectado':
      if (rota === '/configuracoes') return <Configuracoes ir={ir} espacoLivre={estado.espaco_livre} />
      if (rota.startsWith('/gravacao/')) return <Detalhe id={decodeURIComponent(rota.slice(10))} ir={ir} />
      return <Inicio estado={estado} ir={ir} pedidoDeGravar={pedidoDeGravar} />
  }
}

function Abrindo() {
  return (
    <div className="m-body">
      <div className="m-top">
        <Marca />
      </div>
    </div>
  )
}
