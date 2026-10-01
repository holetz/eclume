import { useState, type FormEvent } from 'react'
import { relogio } from '../app/formatos'
import { mensagemDeErro, usePonte } from '../ponte/ponte'
import type { Marcador } from '../ponte/tipos'

/** A nota opcional do marcador que acabou de ser feito: o marcador já existe, a nota vem depois. */
export function NotaDoMarcador({ marcador, aoTerminar }: { marcador: Marcador; aoTerminar: () => void }) {
  const ponte = usePonte()
  const [nota, setNota] = useState(marcador.note ?? '')
  const [erro, setErro] = useState<string | null>(null)

  async function adicionar(evento: FormEvent) {
    evento.preventDefault()
    try {
      await ponte.anotarMarcador(marcador.client_id, nota.trim() || null)
      aoTerminar()
    } catch (e) {
      setErro(mensagemDeErro(e))
    }
  }

  return (
    <form
      className="m-section borda-topo gap-2"
      onSubmit={adicionar}
    >
      <label htmlFor="nota-do-marcador" className="text-muted texto-12">
        Marcador em {relogio(marcador.at_ms)}
      </label>
      <div className="campo-e-botao">
        <input
          id="nota-do-marcador"
          className="input"
          placeholder="Nota (opcional)"
          maxLength={500}
          value={nota}
          onChange={(e) => setNota(e.target.value)}
        />
        <button type="submit" className="btn btn-primary">
          Adicionar
        </button>
      </div>
      {erro && (
        <p className="erro" role="alert">
          {erro}
        </p>
      )}
    </form>
  )
}
