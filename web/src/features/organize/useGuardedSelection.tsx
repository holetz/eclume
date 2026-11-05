import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router'
import { Dialog } from '../../app/Dialog'
import { useLeaveGuard } from '../../app/useLeaveGuard'

/** The selection value for the draft of a new item. */
export const NEW = 'novo'

/**
 * The selection lives in the URL (`?<param>=<id>` or `novo`); with unsaved changes, switching items asks
 * for confirmation, and so does leaving the route or closing the tab (the exit guard).
 */
export function useGuardedSelection(param: string) {
  const { t } = useTranslation('organize')
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
        title={t('discard.title')}
        message={t('discard.text')}
        onClose={() => setPending(undefined)}
        actions={
          <>
            <button type="button" className="btn btn-secondary" onClick={() => setPending(undefined)}>
              {t('discard.keepEditing')}
            </button>
            <button type="button" className="btn btn-danger" onClick={() => apply(pending)}>
              {t('discard.discard')}
            </button>
          </>
        }
      />
    )

  return { selected, select, apply, setDirty, discardDialog }
}
