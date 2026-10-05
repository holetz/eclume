import { useEffect, useRef, useState } from 'react'
import { dataLonga, duracao, relogio, tamanho } from '../app/formatos'
import { IconePausar, IconeTocar } from '../app/Icones'
import { Voltar } from '../app/Voltar'
import { mensagemDeErro, usePonte } from '../ponte/ponte'
import type { DetalheLocal, Etapa } from '../ponte/tipos'
import { SeloDaGravacao } from './ListaDoCelular'
import { ESTADOS_ETAPA, ETAPAS, fraseDaEspera, motivo } from '../app/vocabulario.js'

/** A etapa em palavras, legível sem a cor: o nome quando concluída, o andamento quando ativa e "nome · estado" nas outras. */
function rotuloDaEtapa(etapa: (typeof ETAPAS)[number], estado: Etapa | undefined): string {
  if (!estado || estado.state === 'done') return etapa.nome
  if (estado.state === 'active') return etapa.andamento
  return `${etapa.nome} · ${ESTADOS_ETAPA[estado.state] ?? estado.state}`
}

/** Por que a etapa foi pulada, falhou ou espera você (os locutores sem pessoa); `null` nas outras. */
function motivoDaEtapa(estado: Etapa | undefined): string | null {
  if (estado?.state === 'failed') return estado.error?.message ?? null
  if (estado?.state === 'skipped' || estado?.state === 'waiting') return estado.reason ? motivo(estado.reason) : null
  return null
}

/** As sete etapas na ordem do servidor, cada uma com o estado em palavra, e o motivo das puladas ou com falha. */
function EtapasNoServidor({ etapas }: { etapas: Etapa[] | null }) {
  const linhas = ETAPAS.map((etapa) => {
    const estado = etapas?.find((e) => e.step === etapa.etapa)
    return { etapa, estado, rotulo: rotuloDaEtapa(etapa, estado), motivo: motivoDaEtapa(estado) }
  })
  const motivos = linhas.filter((linha) => linha.motivo)
  return (
    <>
      <ol className="pipeline" aria-label="Etapas no servidor">
        {linhas.map(({ etapa, estado, rotulo }) => (
          <li key={etapa.etapa} data-state={estado?.state === 'pending' ? undefined : estado?.state}>
            {rotulo}
          </li>
        ))}
      </ol>
      {motivos.length > 0 && (
        <ul className="motivos-das-etapas" aria-label="Motivos das etapas">
          {motivos.map(({ etapa, rotulo, motivo: texto }) => (
            <li key={etapa.etapa}>
              {rotulo}: {texto}
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

/** Kbps a partir do tamanho e da duração: "Opus 24 kbps". */
function taxaDoArquivo(bytes: number | null, ms: number | null): string | null {
  if (!bytes || !ms) return null
  return `Opus ${Math.round((bytes * 8) / (ms / 1000) / 1000)} kbps`
}

/** O detalhe de uma gravação: player local, marcadores, as etapas no servidor e a espera na fila. */
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

  async function abrirNaWeb() {
    try {
      await ponte.abrirNaWeb(id)
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
          <div className="m-section gap-curto topo-1">
            <span className="kicker">{dataLonga(gravacao.iniciada_em)}</span>
            <h1 className="m-title">{gravacao.titulo ?? gravacao.titulo_do_servidor ?? 'Sem título'}</h1>
            <span className="alinha-inicio">
              <SeloDaGravacao selo={gravacao.selo} />
            </span>
          </div>
          {detalhe.caminho && (
            <div className="recuo-lateral">
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
                  className="btn btn-primary btn-icon botao-44"
                  aria-label={tocando ? 'Pausar' : 'Tocar'}
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
              <span className="text-muted texto-12">
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
            <div className="m-section gap-2">
              <span className="kicker">No servidor</span>
              <EtapasNoServidor etapas={detalhe.etapas} />
              {detalhe.espera && (
                <p className="text-muted texto-13" role="status">
                  {fraseDaEspera(detalhe.espera)}
                </p>
              )}
              {detalhe.endereco_na_web && (
                <button type="button" className="btn btn-secondary botao-inicio" onClick={abrirNaWeb}>
                  Abrir na web
                </button>
              )}
            </div>
          )}
          <div className="m-section m-fill gap-2">
            <span className="text-muted texto-13">
              {detalhes}
            </span>
            {gravacao.selo === 'sincronizada' && !gravacao.apagada && (
              <>
                <button
                  type="button"
                  className="btn btn-secondary btn-danger botao-inicio"
                  onClick={excluir}
                >
                  Excluir deste celular
                </button>
                <span className="text-muted texto-12">
                  O servidor mantém a cópia dele.
                </span>
              </>
            )}
            {gravacao.apagada && (
              <span className="text-muted texto-12">
                O arquivo já saiu deste celular; a gravação está no servidor.
              </span>
            )}
          </div>
        </>
      )}
    </div>
  )
}
