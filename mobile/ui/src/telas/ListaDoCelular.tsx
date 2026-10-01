import { duracao, marcadores, quando } from '../app/formatos'
import type { GravacaoLocal, Selo } from '../ponte/tipos'
import { ESTADOS_APARELHO, type Tom } from '../app/vocabulario.js'

/** Os selos do celular no vocabulário compartilhado (estados no aparelho). */
const SELOS: Record<Selo, { rotulo: string; tom: Tom }> = {
  gravando: ESTADOS_APARELHO.recording,
  aguardando: ESTADOS_APARELHO.pending,
  sincronizando: ESTADOS_APARELHO.uploading,
  sincronizada: ESTADOS_APARELHO.uploaded,
  interrompida: ESTADOS_APARELHO.interrupted,
  falhou: ESTADOS_APARELHO.failed,
}

export function SeloDaGravacao({ selo }: { selo: Selo }) {
  const { rotulo, tom } = SELOS[selo]
  return <span className={tom === 'neutral' ? 'badge' : `badge badge-${tom}`}>{rotulo}</span>
}

/** A linha de uma gravação: "Hoje 09:00 · 54 min · 3 marcadores". */
function subtitulo(gravacao: GravacaoLocal, agora?: Date): string {
  const partes = [quando(gravacao.iniciada_em, agora), duracao(gravacao.duracao_ms)]
  if (gravacao.marcadores > 0) partes.push(marcadores(gravacao.marcadores))
  return partes.join(' · ')
}

/** "Neste celular": as gravações locais, com o selo de sync. */
export function ListaDoCelular({
  gravacoes,
  resumo,
  abrir,
}: {
  gravacoes: GravacaoLocal[]
  resumo: string
  abrir: (id: string) => void
}) {
  return (
    <div className="m-section m-fill m-rolagem">
      <div className="linha-entre">
        <span className="kicker">Neste celular</span>
        <span className="text-muted texto-12">
          {resumo}
        </span>
      </div>
      {gravacoes.length === 0 ? (
        <p className="text-muted sem-margem texto-14">
          Nenhuma gravação ainda.
        </p>
      ) : (
        <ul className="m-rows">
          {gravacoes.map((gravacao) => (
            <li className="m-row" key={gravacao.id}>
              <button type="button" className="m-row-botao" onClick={() => abrir(gravacao.id)}>
                <span className="m-row-title">{gravacao.titulo ?? 'Sem título'}</span>
                <span className="m-row-sub">{subtitulo(gravacao)}</span>
              </button>
              <span className="m-row-end">
                <SeloDaGravacao selo={gravacao.selo} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
