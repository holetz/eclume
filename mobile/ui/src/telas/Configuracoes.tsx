import { useEffect, useState, type ReactNode } from 'react'
import { tamanho } from '../app/formatos'
import { Voltar } from '../app/Voltar'
import { mensagemDeErro, usePonte } from '../ponte/ponte'
import type { Atualizacao, Configuracoes as Dados, Preferencias, Qualidade } from '../ponte/tipos'

const MB_POR_HORA: Record<Qualidade, number> = { padrao: 11, alta: 22 }

function Linha({ titulo, sub, children }: { titulo: string; sub?: string; children?: ReactNode }) {
  return (
    <li className="m-row m-row-alta">
      <span className="m-row-title m-row-title-corpo">
        {titulo}
      </span>
      {sub && <span className="m-row-sub">{sub}</span>}
      <span className="m-row-end">{children}</span>
    </li>
  )
}

function Chave({
  rotulo,
  ligada,
  desabilitada,
  aoMudar,
}: {
  rotulo: string
  ligada: boolean
  desabilitada?: boolean
  aoMudar?: (ligada: boolean) => void
}) {
  return (
    <label className="switch">
      <input
        type="checkbox"
        aria-label={rotulo}
        checked={ligada}
        disabled={desabilitada}
        onChange={(e) => aoMudar?.(e.target.checked)}
      />
      <span className="track" />
    </label>
  )
}

/** Configurações: servidor, sincronização, áudio, armazenamento, sair e a versão. */
export function Configuracoes({ ir, espacoLivre }: { ir: (rota: string) => void; espacoLivre: string | null }) {
  const ponte = usePonte()
  const [dados, setDados] = useState<Dados | null>(null)
  const [atualizacao, setAtualizacao] = useState<Atualizacao | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  const [confirmandoSaida, setConfirmandoSaida] = useState(false)
  const [pendentes, setPendentes] = useState(0)

  useEffect(() => {
    let ativo = true
    ponte
      .configuracoes()
      .then((lido) => ativo && setDados(lido))
      .catch((e) => ativo && setErro(mensagemDeErro(e)))
    ponte
      .verificarAtualizacao()
      .then((nova) => ativo && setAtualizacao(nova))
      .catch(() => {})
    ponte
      .estado()
      .then((estado) => ativo && setPendentes(estado.pendentes))
      .catch(() => {})
    return () => {
      ativo = false
    }
  }, [ponte])

  async function mudar(parcial: Partial<Preferencias>) {
    if (!dados) return
    const preferencias = { ...dados.preferencias, ...parcial }
    setDados({ ...dados, preferencias })
    try {
      await ponte.salvarConfiguracoes(preferencias)
    } catch (e) {
      setErro(mensagemDeErro(e))
    }
  }

  async function sair() {
    try {
      await ponte.sair()
      ir('/servidor')
    } catch (e) {
      setErro(mensagemDeErro(e))
    }
  }

  async function atualizar() {
    setErro(null)
    try {
      await ponte.atualizar()
    } catch (e) {
      setErro(mensagemDeErro(e))
    }
  }

  const preferencias = dados?.preferencias
  return (
    <div className="m-body m-rolagem">
      <Voltar rotulo="Início" aoVoltar={() => ir('/')} />
      <div className="m-section sem-topo">
        <h1 className="m-title">Configurações</h1>
      </div>
      {dados && preferencias && (
        <div className="m-section m-fill gap-3 topo-1">
          <div className="m-group">
            <span className="kicker">Servidor</span>
            <ul className="m-rows">
              <Linha titulo="Endereço">
                <span className="mono text-muted texto-14">
                  {dados.servidor ? new URL(dados.servidor).host : '—'}
                </span>
              </Linha>
            </ul>
          </div>
          <div className="m-group">
            <span className="kicker">Sincronização</span>
            <ul className="m-rows">
              <Linha titulo="Sincronizar automaticamente" sub="Na rede do servidor">
                <Chave
                  rotulo="Sincronizar automaticamente"
                  ligada={preferencias.sync_auto}
                  aoMudar={(sync_auto) => mudar({ sync_auto })}
                />
              </Linha>
              <Linha titulo="Só no Wi‑Fi do servidor" sub="Nunca usa dados móveis">
                <Chave rotulo="Só no Wi‑Fi do servidor" ligada desabilitada />
              </Linha>
            </ul>
          </div>
          <div className="m-group">
            <span className="kicker">Áudio</span>
            <ul className="m-rows">
              <Linha titulo="Qualidade" sub={`Cerca de ${MB_POR_HORA[preferencias.qualidade]} MB por hora`}>
                <div className="seg" role="radiogroup" aria-label="Qualidade">
                  {(['padrao', 'alta'] as const).map((q) => (
                    <label className="seg-opt" key={q}>
                      <input
                        type="radio"
                        name="qualidade"
                        checked={preferencias.qualidade === q}
                        onChange={() => mudar({ qualidade: q })}
                      />
                      {q === 'padrao' ? 'Padrão' : 'Alta'}
                    </label>
                  ))}
                </div>
              </Linha>
            </ul>
          </div>
          <div className="m-group">
            <span className="kicker">Armazenamento</span>
            <ul className="m-rows">
              <Linha titulo="Excluir depois de sincronizar" sub={`Mantém os últimos ${dados.reter_dias} dias`}>
                <Chave
                  rotulo="Excluir depois de sincronizar"
                  ligada={preferencias.excluir_sincronizadas}
                  aoMudar={(excluir_sincronizadas) => mudar({ excluir_sincronizadas })}
                />
              </Linha>
              <Linha titulo="Neste celular">
                <span className="text-muted texto-14">
                  {tamanho(dados.uso_bytes)}
                  {espacoLivre ? ` · ${espacoLivre.replace(/^cerca de /, '')} livres` : ''}
                </span>
              </Linha>
            </ul>
          </div>
        </div>
      )}
      <div className="m-section gap-2">
        {erro && (
          <p className="erro" role="alert">
            {erro}
          </p>
        )}
        {confirmandoSaida ? (
          <div className="alert alert-warning" role="alertdialog" aria-label="Sair e esquecer o servidor">
            <span className="alert-title">Sair e esquecer o servidor?</span>
            <span>
              {pendentes > 0
                ? `${pendentes === 1 ? '1 gravação aguarda' : `${pendentes} gravações aguardam`} o sync: elas ficam no celular e sobem no próximo servidor pareado. `
                : ''}
              Desvincule este aparelho na web, em Minhas configurações → App móvel: o acesso dele não se
              revoga sozinho.
            </span>
            <div className="duas-colunas margem-topo-2">
              <button type="button" className="btn btn-secondary btn-danger" onClick={sair}>
                Sair
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setConfirmandoSaida(false)}>
                Cancelar
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="btn btn-secondary btn-danger botao-inicio"
            onClick={() => setConfirmandoSaida(true)}
          >
            Sair e esquecer o servidor
          </button>
        )}
        <span className="text-muted texto-12">
          eclume para Android · v{dados?.versao ?? ''}
        </span>
        {atualizacao && (
          <button type="button" className="btn btn-primary botao-inicio" onClick={atualizar}>
            Nova versão disponível · v{atualizacao.versao}
          </button>
        )}
      </div>
    </div>
  )
}
