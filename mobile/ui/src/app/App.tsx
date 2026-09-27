import { useEffect } from 'react'
import { usePonte } from '../ponte/ponte'
import type { EstadoApp } from '../ponte/tipos'
import { Endereco } from '../telas/Endereco'
import { Entrar } from '../telas/Entrar'
import { Gravando } from '../telas/Gravando'
import { Inicio } from '../telas/Inicio'
import { LerCodigo } from '../telas/LerCodigo'
import { Servidor } from '../telas/Servidor'
import { useEstadoApp } from './estado'
import { Marca } from './Marca'
import { useRota } from './rotas'

/** A casca do app: a tela sai do `EstadoApp` (conexão, sessão) e da rota do hash. */
export default function App() {
  const ponte = usePonte()
  const estado = useEstadoApp()
  const [rota, ir] = useRota()

  useEffect(() => {
    const aoMudar = () => ponte.visibilidade(document.visibilityState === 'visible').catch(() => {})
    document.addEventListener('visibilitychange', aoMudar)
    return () => document.removeEventListener('visibilitychange', aoMudar)
  }, [ponte])

  return (
    <main className="m-app">{estado ? <Tela estado={estado} rota={rota} ir={ir} /> : <Abrindo />}</main>
  )
}

function Tela({ estado, rota, ir }: { estado: EstadoApp; rota: string; ir: (rota: string) => void }) {
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
      if (estado.sessao || estado.folha) return <Gravando estado={estado} />
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
