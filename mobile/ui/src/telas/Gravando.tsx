import { useState } from 'react'
import { relogio } from '../app/formatos'
import { IconeMarcador, IconePausar, IconeParar, IconeTocar } from '../app/Icones'
import { mensagemDeErro, usePonte } from '../ponte/ponte'
import type { EstadoApp, Marcador } from '../ponte/tipos'
import { GravacaoSalva } from './GravacaoSalva'
import { Medidor } from './Medidor'
import { NotaDoMarcador } from './NotaDoMarcador'

/**
 * Gravando e Pausado: o relógio é o tempo de áudio, o medidor é o nível, e os marcadores ficam na
 * lista. Marcador marca na hora; a nota vem depois, opcional. Depois de Parar, a folha "Gravação
 * salva" pede título e tipo de agenda.
 */
export function Gravando({ estado }: { estado: EstadoApp }) {
  const ponte = usePonte()
  const [anotando, setAnotando] = useState<Marcador | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  const sessao = estado.sessao
  const pausada = sessao?.pausada ?? false

  async function rodar(acao: () => Promise<unknown>) {
    setErro(null)
    try {
      await acao()
    } catch (e) {
      setErro(mensagemDeErro(e))
    }
  }

  async function marcar() {
    await rodar(async () => setAnotando(await ponte.marcar(null)))
  }

  async function parar() {
    setAnotando(null)
    await rodar(() => ponte.parar())
  }

  const marcadores = sessao?.marcadores ?? []
  const audioMs = sessao?.audio_ms ?? estado.folha?.duracao_ms ?? 0
  const bateria = estado.avisos.bateria
  return (
    <div className="m-body" style={{ paddingBottom: 0 }}>
      <div className="m-top">
        <span className="status-line" data-status={pausada ? 'paused' : 'recording'}>
          {pausada ? 'Pausado' : 'Gravando'}
        </span>
        {estado.espaco_livre && (
          <span className="text-muted" style={{ fontSize: 13 }}>
            Espaço livre: {estado.espaco_livre}
          </span>
        )}
      </div>
      {bateria && (
        <div className="alert alert-warning" style={{ margin: '0 20px' }} role="status">
          <span className="alert-title">Bateria em {bateria.pct} %</span>
          <span>
            {bateria.restante ? `Dá para ${bateria.restante}. ` : ''}A gravação fica salva se o celular
            desligar.
          </span>
        </div>
      )}
      <div className="m-section" style={{ gap: 20, paddingTop: 24 }}>
        <span className="m-timer" aria-label="Tempo de áudio">
          {relogio(audioMs)}
        </span>
        <Medidor nivel={sessao?.nivel ?? 0} pausado={pausada || !sessao} />
      </div>
      <div className="m-section m-fill m-rolagem">
        <div className="linha-entre">
          <span className="kicker">Marcadores</span>
          <span className="text-muted" style={{ fontSize: 12 }}>
            {marcadores.length}
          </span>
        </div>
        <ul className="markers">
          {marcadores.map((m) => (
            <li key={m.client_id} data-empty={m.note ? undefined : ''}>
              <span className="timecode">{relogio(m.at_ms)}</span>
              <span>{m.note ?? 'Marcador'}</span>
            </li>
          ))}
        </ul>
        {erro && (
          <p className="erro" role="alert">
            {erro}
          </p>
        )}
      </div>
      {anotando && <NotaDoMarcador marcador={anotando} aoTerminar={() => setAnotando(null)} />}
      <div className="m-cells">
        {pausada ? (
          <button type="button" className="m-cell" aria-pressed="true" onClick={() => rodar(() => ponte.continuar())}>
            <IconeTocar />
            Continuar
          </button>
        ) : (
          <button type="button" className="m-cell" aria-pressed="false" onClick={() => rodar(() => ponte.pausar())}>
            <IconePausar />
            Pausar
          </button>
        )}
        <button type="button" className="m-cell" disabled={!sessao} onClick={marcar}>
          <IconeMarcador />
          Marcador
        </button>
        <button type="button" className="m-cell m-cell-stop" disabled={!sessao} onClick={parar}>
          <IconeParar />
          Parar
        </button>
      </div>
      <div className="m-rodape" />
      {estado.folha && <GravacaoSalva folha={estado.folha} />}
    </div>
  )
}
