import { useEffect, useState, type FormEvent } from 'react'
import { duracao, marcadores, tituloSugerido } from '../app/formatos'
import { mensagemDeErro, usePonte } from '../ponte/ponte'
import type { Folha, TipoDeAgenda } from '../ponte/tipos'

/**
 * A folha "Gravação salva", depois de Parar: título e tipo de agenda, os dois opcionais. Enquanto
 * ela está aberta, o sync espera (até 10 min); Salvar ou Pular o libera.
 */
export function GravacaoSalva({ folha }: { folha: Folha }) {
  const ponte = usePonte()
  const [titulo, setTitulo] = useState('')
  const [tipo, setTipo] = useState<string | null>(null)
  const [tipos, setTipos] = useState<TipoDeAgenda[]>([])
  const [erro, setErro] = useState<string | null>(null)

  useEffect(() => {
    let ativo = true
    ponte
      .tiposDeAgenda()
      .then((lista) => ativo && setTipos(lista))
      .catch(() => {})
    return () => {
      ativo = false
    }
  }, [ponte])

  async function concluir(salvar: boolean) {
    setErro(null)
    try {
      await ponte.salvar(folha.id, salvar ? titulo.trim() || null : null, salvar ? tipo : null)
    } catch (e) {
      setErro(mensagemDeErro(e))
    }
  }

  function enviar(evento: FormEvent) {
    evento.preventDefault()
    concluir(true)
  }

  return (
    <div className="sheet-backdrop">
      <form className="sheet" onSubmit={enviar} aria-labelledby="titulo-da-folha">
        <span className="sheet-grip" />
        <div className="stack-curta" style={{ gap: 4 }}>
          <h2 id="titulo-da-folha" className="m-title" style={{ fontSize: 24 }}>
            Gravação salva
          </h2>
          <span className="text-muted" style={{ fontSize: 14 }}>
            {duracao(folha.duracao_ms)} · {marcadores(folha.marcadores)} · neste celular
          </span>
        </div>
        <div className="field">
          <label htmlFor="titulo">Título (opcional)</label>
          <input
            id="titulo"
            className="input"
            placeholder={tituloSugerido(folha.iniciada_em)}
            value={titulo}
            onChange={(e) => setTitulo(e.target.value)}
          />
        </div>
        {tipos.length > 0 && (
          <div className="field">
            <span className="rotulo-do-campo">Tipo de agenda (opcional)</span>
            <div className="m-chips">
              {tipos.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className="m-chip"
                  aria-pressed={tipo === t.id}
                  onClick={() => setTipo(tipo === t.id ? null : t.id)}
                >
                  {t.nome}
                </button>
              ))}
            </div>
          </div>
        )}
        <span className="text-muted" style={{ fontSize: 13 }}>
          O servidor preenche os outros campos ao transcrever.
        </span>
        {erro && (
          <p className="erro" role="alert">
            {erro}
          </p>
        )}
        <div className="duas-colunas">
          <button type="submit" className="btn btn-primary" style={{ justifyContent: 'flex-start' }}>
            Salvar
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            style={{ justifyContent: 'flex-start' }}
            onClick={() => concluir(false)}
          >
            Pular
          </button>
        </div>
      </form>
    </div>
  )
}
