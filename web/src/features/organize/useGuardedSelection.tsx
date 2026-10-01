import { useCallback, useState } from 'react'
import { useSearchParams } from 'react-router'
import { Dialog } from '../../app/Dialog'
import { useLeaveGuard } from '../../app/useLeaveGuard'

/** O valor da seleção para o rascunho de um item novo. */
export const NEW = 'novo'

/**
 * A seleção vive na URL (`?<param>=<id>` ou `novo`); com alterações não salvas, trocar de item pede
 * confirmação, e sair da rota ou fechar a aba também (o guarda de saída).
 */
export function useGuardedSelection(param: string) {
  const [params, setParams] = useSearchParams()
  const [dirty, setDirty] = useState(false)
  const [pending, setPending] = useState<string | null | undefined>(undefined)
  const selected = params.get(param)

  const apply = useCallback(
    (id: string | null) => {
      setDirty(false)
      setPending(undefined)
      setParams(id ? { [param]: id } : {}, { replace: true })
    },
    [param, setParams],
  )

  const select = (id: string | null) => {
    if (id === selected) return
    if (dirty) setPending(id)
    else apply(id)
  }

  const leaveDialog = useLeaveGuard(dirty)

  const discardDialog =
    pending === undefined ? leaveDialog : (
      <Dialog
        title="Descartar alterações?"
        message="As alterações ainda não foram salvas."
        onClose={() => setPending(undefined)}
        actions={
          <>
            <button type="button" className="btn btn-secondary" onClick={() => setPending(undefined)}>
              Continuar editando
            </button>
            <button type="button" className="btn btn-danger" onClick={() => apply(pending)}>
              Descartar
            </button>
          </>
        }
      />
    )

  return { selected, select, apply, setDirty, discardDialog }
}
