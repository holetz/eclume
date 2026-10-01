import { useEffect } from 'react'
import { useRouteError } from 'react-router'
import { PageHead } from './PageHead'
import { PageStatus } from './RequireSession'
import { usePageTitle } from './usePageTitle'

// Mensagens do `import()` dinâmico que falhou no Chromium, no Firefox e no WebKit, e a do preload do Vite.
const CHUNK_FAILURE =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i

function isChunkError(error: unknown): boolean {
  return error instanceof Error && CHUNK_FAILURE.test(error.message)
}

function useErrorCopy() {
  const error = useRouteError()
  useEffect(() => console.error(error), [error])
  return isChunkError(error)
    ? { title: 'O eclume foi atualizado', text: 'Esta tela mudou desde que a aba foi aberta. Recarregue para usar a versão nova.' }
    : { title: 'Algo deu errado nesta tela', text: 'Recarregue a página; se o erro continuar, avise quem administra o eclume.' }
}

function ReloadButton() {
  return (
    <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
      Recarregar
    </button>
  )
}

/** Erro de uma página autenticada: aparece no `Outlet` do shell, que continua de pé. */
export function RouteError() {
  const { title, text } = useErrorCopy()
  return (
    <section>
      <PageHead title={title} />
      <p className="text-muted">{text}</p>
      <ReloadButton />
    </section>
  )
}

/** Erro fora do shell (login, cadastro, parear, admin): página inteira, sem a raiz desmontar. */
export function RootError() {
  const { title, text } = useErrorCopy()
  usePageTitle(title)
  return (
    <main>
      <PageStatus>
        <h1>{title}</h1>
        <p>{text}</p>
        <ReloadButton />
      </PageStatus>
    </main>
  )
}
