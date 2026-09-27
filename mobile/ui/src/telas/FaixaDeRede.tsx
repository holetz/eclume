import { useState } from 'react'
import { taxa } from '../app/formatos'
import { mensagemDeErro, usePonte } from '../ponte/ponte'
import type { EstadoRede } from '../ponte/tipos'

/** A faixa `.m-net`: na rede do eclume, fora dela ou sincronizando. */
export function FaixaDeRede({ rede, pendentes }: { rede: EstadoRede; pendentes: number }) {
  const ponte = usePonte()
  const [erro, setErro] = useState<string | null>(null)

  async function sincronizar() {
    setErro(null)
    try {
      await ponte.sincronizarAgora()
    } catch (e) {
      setErro(mensagemDeErro(e))
    }
  }

  switch (rede.estado) {
    case 'syncing':
      return (
        <div className="m-net" style={{ display: 'grid', gap: 6, padding: '10px 20px' }}>
          <div className="linha-entre">
            <span className="status-line" data-status="syncing">
              Sincronizando {rede.i} de {rede.n}
            </span>
            <span className="text-muted mono" style={{ fontSize: 12 }}>
              {rede.pct} %{rede.bytes_s > 0 ? ` · ${taxa(rede.bytes_s)}` : ''}
            </span>
          </div>
          <progress className="progress" value={rede.pct} max={100} aria-label="Andamento do envio" />
        </div>
      )
    case 'on_network':
      return (
        <div className="m-net">
          <span className="status-line" data-status="synced">
            Na rede do eclume
          </span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={sincronizar}>
            Sincronizar agora
          </button>
          {erro && <span className="erro">{erro}</span>}
        </div>
      )
    case 'ca_mismatch':
      return (
        <div className="m-net">
          <span className="status-line" data-status="away">
            O certificado do servidor mudou
          </span>
          <span className="text-muted" style={{ fontSize: 13 }}>
            Nada sobe até parear de novo
          </span>
        </div>
      )
    default:
      return (
        <div className="m-net">
          <span className="status-line" data-status="away">
            Fora da rede do eclume
          </span>
          {pendentes > 0 && (
            <span className="text-muted" style={{ fontSize: 13 }}>
              {pendentes} aguardando
            </span>
          )}
        </div>
      )
  }
}
