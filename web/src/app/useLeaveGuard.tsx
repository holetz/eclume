import { useEffect, type ReactNode } from 'react'
import { useBlocker } from 'react-router'
import { Dialog } from './Dialog'

interface LeaveCopy {
  title: string
  message: ReactNode
}

const DEFAULT_COPY: LeaveCopy = { title: 'Descartar alterações?', message: 'As alterações ainda não foram salvas.' }

/**
 * Guarda de saída de um formulário com alterações não salvas: fechar ou recarregar a aba dispara o
 * aviso do navegador, e ir para outra rota do app pede confirmação. Mudar só a busca ou o `#` da
 * mesma rota (o `?t=` da gravação, a seleção na URL) não pede nada. Devolve o diálogo a renderizar.
 */
export function useLeaveGuard(dirty: boolean, copy: LeaveCopy = DEFAULT_COPY): ReactNode {
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname,
  )
  if (blocker.state !== 'blocked') return null
  return (
    <Dialog
      title={copy.title}
      message={copy.message}
      onClose={() => blocker.reset()}
      actions={
        <>
          <button type="button" className="btn btn-secondary" onClick={() => blocker.reset()}>
            Continuar editando
          </button>
          <button type="button" className="btn btn-danger" onClick={() => blocker.proceed()}>
            Descartar
          </button>
        </>
      }
    />
  )
}
