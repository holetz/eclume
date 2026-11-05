import { useTranslation } from 'react-i18next'
import { useEffect } from 'react'
import { useRouteError } from 'react-router'
import { PageHead } from './PageHead'
import { PageStatus } from './RequireSession'
import { usePageTitle } from './usePageTitle'

// Messages of the failed dynamic `import()` in Chromium, Firefox and WebKit, and Vite's preload one.
const CHUNK_FAILURE =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i

function isChunkError(error: unknown): boolean {
  return error instanceof Error && CHUNK_FAILURE.test(error.message)
}

function useErrorCopy() {
  const { t } = useTranslation('shell')
  const error = useRouteError()
  useEffect(() => console.error(error), [error])
  return isChunkError(error)
    ? { title: t('routeError.updatedTitle'), text: t('routeError.updatedText') }
    : { title: t('routeError.failedTitle'), text: t('routeError.failedText') }
}

function ReloadButton() {
  const { t } = useTranslation('shell')
  return (
    <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
      {t('routeError.reload')}
    </button>
  )
}

/** Error of an authenticated page: shows in the shell's `Outlet`, which stays up. */
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

/** Error outside the shell (login, signup, pair, admin): full page, without the root unmounting. */
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
