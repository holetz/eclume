import { useEffect, useRef, useState } from 'react'
import { dataLonga, duracao, relogio, tamanho } from '../app/formatos'
import { IconePausar, IconeTocar } from '../app/Icones'
import { Voltar } from '../app/Voltar'
import { mensagemDeErro, usePonte } from '../ponte/ponte'
import type { DetalheLocal, Etapa } from '../ponte/tipos'
import { SeloDaGravacao } from './ListaDoCelular'

/** As etapas da #33 que o celular mostra, na ordem. */
const ETAPAS: { step: string; nome: string }[] = [
  { step: 'received', nome: 'Áudio recebido' },
  { step: 'preprocessing', nome: 'Pré-processamento' },
  { step: 'transcription', nome: 'Transcrição' },
  { step: 'fields', nome: 'Campos preenchidos' },
  { step: 'summary', nome: 'Resumo' },
]

function estadoDaEtapa(etapas: Etapa[] | null, step: string): Etapa['state'] | undefined {
  const estado = etapas?.find((e) => e.step === step)?.state
  return estado === 'pending' ? undefined : estado
}

/** Kbps a partir do tamanho e da duração: "Opus 24 kbps". */
function taxaDoArquivo(bytes: number | null, ms: number | null): string | null {
  if (!bytes || !ms) return null
  return `Opus ${Math.round((bytes * 8) / (ms / 1000) / 1000)} kbps`
}

/** O detalhe de uma gravação: player local, marcadores e as etapas no servidor. */
export function Detalhe({ id, ir }: { id: string; ir: (rota: string) => void }) {
  const ponte = usePonte()
  const [detalhe, setDetalhe] = useState<DetalheLocal | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  const [tocando, setTocando] = useState(false)
  const [posicao, setPosicao] = useState(0)
  const audio = useRef<HTMLAudioElement>(null)

  useEffect(() => {
    let ativo = true
    ponte
      .gravacao(id)
      .then((lido) => ativo && setDetalhe(lido))
      .catch((e) => ativo && setErro(mensagemDeErro(e)))
    return () => {
      ativo = false
    }
  }, [ponte, id])

  async function excluir() {
    try {
      await ponte.excluirLocal(id)
      setDetalhe(await ponte.gravacao(id))
    } catch (e) {
      setErro(mensagemDeErro(e))
    }
  }

  function alternar() {
    const elemento = audio.current
    if (!elemento) return
    if (elemento.paused) elemento.play().catch(() => {})
    else elemento.pause()
  }

  function pular(ms: number) {
    if (audio.current) audio.current.currentTime = ms / 1000
  }

  const gravacao = detalhe?.gravacao
  const total = gravacao?.duracao_ms ?? 0
  const detalhes = gravacao
    ? [duracao(gravacao.duracao_ms), tamanho(gravacao.bytes), taxaDoArquivo(gravacao.bytes, gravacao.duracao_ms), gravacao.tipo_de_agenda]
        .filter(Boolean)
        .join(' · ')
    : ''
  return (
    <div className="m-body m-rolagem">
      <Voltar rotulo="Neste celular" aoVoltar={() => ir('/')} />
      {erro && (
        <p className="erro m-section" role="alert">
          {erro}
        </p>
      )}
      {detalhe && gravacao && (
        <>
          <div className="m-section" style={{ gap: 6, paddingTop: 4 }}>
            <span className="kicker">{dataLonga(gravacao.iniciada_em)}</span>
            <h1 className="m-title">{gravacao.titulo ?? 'Sem título'}</h1>
            <span style={{ justifySelf: 'start' }}>
              <SeloDaGravacao selo={gravacao.selo} />
            </span>
          </div>
          {detalhe.caminho && (
            <div style={{ padding: '0 20px' }}>
              <audio
                ref={audio}
                src={ponte.urlDoArquivo(detalhe.caminho)}
                preload="metadata"
                onPlay={() => setTocando(true)}
                onPause={() => setTocando(false)}
                onTimeUpdate={(e) => setPosicao(e.currentTarget.currentTime * 1000)}
              />
              <div className="player">
                <button
                  type="button"
                  className="btn btn-primary btn-icon"
                  aria-label={tocando ? 'Pausar' : 'Tocar'}
                  style={{ width: 44, height: 44 }}
                  onClick={alternar}
                >
                  {tocando ? <IconePausar /> : <IconeTocar />}
                </button>
                <span>{relogio(posicao)}</span>
                <progress className="progress" value={total ? (posicao / total) * 100 : 0} max={100} />
                <span className="text-muted">{relogio(total)}</span>
              </div>
            </div>
          )}
          <div className="m-section">
            <div className="linha-entre">
              <span className="kicker">Marcadores</span>
              <span className="text-muted" style={{ fontSize: 12 }}>
                {detalhe.marcadores.length}
              </span>
            </div>
            <ul className="markers">
              {detalhe.marcadores.map((m) => (
                <li key={m.client_id} data-empty={m.note ? undefined : ''}>
                  <button type="button" className="timecode botao-texto" onClick={() => pular(m.at_ms)}>
                    {relogio(m.at_ms)}
                  </button>
                  <span>{m.note ?? 'Marcador'}</span>
                </li>
              ))}
            </ul>
          </div>
          {gravacao.remote_id && (
            <div className="m-section" style={{ gap: 8 }}>
              <span className="kicker">No servidor</span>
              <ol className="pipeline">
                {ETAPAS.map((etapa) => (
                  <li key={etapa.step} data-state={estadoDaEtapa(detalhe.etapas, etapa.step)}>
                    {etapa.nome}
                  </li>
                ))}
              </ol>
            </div>
          )}
          <div className="m-section m-fill" style={{ gap: 8 }}>
            <span className="text-muted" style={{ fontSize: 13 }}>
              {detalhes}
            </span>
            {gravacao.selo === 'sincronizada' && !gravacao.apagada && (
              <>
                <button
                  type="button"
                  className="btn btn-secondary btn-danger"
                  style={{ justifyContent: 'flex-start' }}
                  onClick={excluir}
                >
                  Excluir deste celular
                </button>
                <span className="text-muted" style={{ fontSize: 12 }}>
                  O servidor mantém a cópia dele.
                </span>
              </>
            )}
            {gravacao.apagada && (
              <span className="text-muted" style={{ fontSize: 12 }}>
                O arquivo já saiu deste celular; a gravação está no servidor.
              </span>
            )}
          </div>
        </>
      )}
    </div>
  )
}
