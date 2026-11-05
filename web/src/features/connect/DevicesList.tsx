import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api, type Schemas } from '../../api/client'
import { errorMessage, unwrap } from '../../api/problem'
import { ConfirmDialog } from '../../app/ConfirmDialog'
import { useTranslation } from 'react-i18next'
import { activeLocale, i18n } from '../../i18n'
import { TOKENS_KEY, type DevicePlatform } from '../tokens/scopes'
import styles from './Connect.module.css'
import { useDeviceTokens } from './pairing'

type Token = Schemas['Token']

const dayMonth = () => new Intl.DateTimeFormat(activeLocale(), { day: '2-digit', month: '2-digit' })
const hourMinute = () => new Intl.DateTimeFormat(activeLocale(), { hour: '2-digit', minute: '2-digit' })

/** "today 09:58", "yesterday 16:40" or "09/12 09:58", in the active locale. */
function formatSync(iso: string, now: Date = new Date()): string {
  const date = new Date(iso)
  const days = Math.round(
    (new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() -
      new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()) /
      86_400_000,
  )
  const day =
    days === 0 ? i18n.t('connect:devices.today') : days === 1 ? i18n.t('connect:devices.yesterday') : dayMonth().format(date)
  return `${day} ${hourMinute().format(date)}`
}

interface DevicesListProps {
  title: string
  platforms: readonly DevicePlatform[]
  empty: string
  /** What happens to the unpaired device, in the confirmation dialog. */
  unpairMessage: string
}

/** The paired devices of these platforms, with Unpair (revokes the device's credential). */
export function DevicesList({ title, platforms, empty, unpairMessage }: DevicesListProps) {
  const { t } = useTranslation('connect')
  const devices = useDeviceTokens()
  const [unpairing, setUnpairing] = useState<Token | null>(null)
  const items = (devices.data?.items ?? []).filter(
    (token) => !token.revoked_at && token.platform !== null && platforms.includes(token.platform),
  )

  return (
    <section className={styles.devices} aria-label={title}>
      <h4>{title}</h4>
      {devices.isPending && <p role="status">{t('devices.loading')}</p>}
      {devices.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(devices.error)}
        </p>
      )}
      {devices.isSuccess && items.length === 0 && <p className="text-muted">{empty}</p>}
      {items.length > 0 && (
        <ul className={`list ${styles.list}`}>
          {items.map((token) => (
            <li key={token.id} className="list-row">
              <span className="list-row-title">{token.name}</span>
              <span className="list-row-sub">
                {t('devices.paired', { date: dayMonth().format(new Date(token.created_at)) })} ·{' '}
                {token.last_used_at
                  ? t('devices.lastSync', { when: formatSync(token.last_used_at) })
                  : t('devices.neverSynced')}
              </span>
              <span className="list-row-actions">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm btn-danger"
                  onClick={() => setUnpairing(token)}
                  aria-label={t('devices.unpairName', { name: token.name })}
                >
                  {t('devices.unpair')}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {unpairing && <UnpairDialog token={unpairing} message={unpairMessage} onClose={() => setUnpairing(null)} />}
    </section>
  )
}

function UnpairDialog({ token, message, onClose }: { token: Token; message: string; onClose: () => void }) {
  const { t } = useTranslation('connect')
  const queryClient = useQueryClient()
  const unpair = useMutation({
    mutationFn: () => unwrap(api.DELETE('/api/v1/tokens/{token_id}', { params: { path: { token_id: token.id } } })),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: TOKENS_KEY })
      onClose()
    },
  })
  return (
    <ConfirmDialog
      title={t('devices.unpairTitle', { name: token.name })}
      confirmLabel={t('devices.unpair')}
      onConfirm={() => unpair.mutate()}
      onCancel={onClose}
      busy={unpair.isPending}
    >
      {message}
      {unpair.isError && (
        <span className="alert alert-error" role="alert">
          {errorMessage(unpair.error)}
        </span>
      )}
    </ConfirmDialog>
  )
}
