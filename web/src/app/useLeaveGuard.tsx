import { useTranslation } from 'react-i18next'
import { useEffect, type ReactNode } from 'react'
import { useBlocker } from 'react-router'
import { Dialog } from './Dialog'

interface LeaveOptions {
  title: string
  message: ReactNode
  /** Runs when the person confirms leaving, before navigating (e.g.: deleting the saved draft). */
  onDiscard?: () => void
}

/**
 * Leave guard of a form with unsaved changes: closing or reloading the tab fires the
 * browser's warning, and going to another app route asks for confirmation. Changing only the search or the `#` of the
 * same route (the recording's `?t=`, the selection in the URL) asks nothing. Returns the dialog to render.
 */
export function useLeaveGuard(dirty: boolean, custom?: LeaveOptions): ReactNode {
  const { t } = useTranslation('shell')
  const options = custom ?? { title: t('leave.title'), message: t('leave.message') }
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
      title={options.title}
      message={options.message}
      onClose={() => blocker.reset()}
      actions={
        <>
          <button type="button" className="btn btn-secondary" onClick={() => blocker.reset()}>
            {t('leave.keepEditing')}
          </button>
          <button type="button" className="btn btn-danger" onClick={() => {
              options.onDiscard?.()
              blocker.proceed()
            }}
          >
            {t('leave.discard')}
          </button>
        </>
      }
    />
  )
}
