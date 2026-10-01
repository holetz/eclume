import { useEffect } from 'react'
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

/** A casca do app: a tela sai do `EstadoApp` (conexão, sessão) e da rota do hash. */
export default function App() {
  const ponte = usePonte()
  const estado = useEstadoApp()
  const [rota, ir] = useRota()

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
    <main className="m-app">{estado ? <Tela estado={estado} rota={rota} ir={ir} /> : <Abrindo />}</main>
  )
}

function Tela({ estado, rota, ir }: { estado: EstadoApp; rota: string; ir: (rota: string) => void }) {
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
      return <Entrar servidor={conexao.servidor} ir={ir} />
    case 'conectado':
      if (rota === '/configuracoes') return <Configuracoes ir={ir} espacoLivre={estado.espaco_livre} />
      if (rota.startsWith('/gravacao/')) return <Detalhe id={decodeURIComponent(rota.slice(10))} ir={ir} />
      return <Inicio estado={estado} ir={ir} />
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
