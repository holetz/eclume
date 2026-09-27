import { IconeVoltar } from './Icones'

/** A barra do topo com o botão de voltar do DS (`.m-back`). */
export function Voltar({ rotulo, aoVoltar }: { rotulo: string; aoVoltar: () => void }) {
  return (
    <div className="m-top" style={{ paddingLeft: 12 }}>
      <button type="button" className="m-back" onClick={aoVoltar}>
        <IconeVoltar />
        {rotulo}
      </button>
    </div>
  )
}
