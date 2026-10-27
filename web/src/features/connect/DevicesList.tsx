import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api, type Schemas } from '../../api/client'
import { errorMessage, unwrap } from '../../api/problem'
import { ConfirmDialog } from '../../app/ConfirmDialog'
import { TOKENS_KEY, type DevicePlatform } from '../tokens/scopes'
import styles from './Connect.module.css'
import { useDeviceTokens } from './pairing'

type Token = Schemas['Token']

const dayMonth = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' })
const hourMinute = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' })

/** "hoje 09:58", "ontem 16:40" or "12/09 09:58". */
function formatSync(iso: string, now: Date = new Date()): string {
  const date = new Date(iso)
  const days = Math.round(
    (new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() -
      new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()) /
      86_400_000,
  )
  const day = days === 0 ? 'hoje' : days === 1 ? 'ontem' : dayMonth.format(date)
  return `${day} ${hourMinute.format(date)}`
}

interface DevicesListProps {
  title: string
  platforms: readonly DevicePlatform[]
  empty: string
  /** What happens to the unpaired device, in the confirmation dialog. */
  unpairMessage: string
}

/** The paired devices of these platforms, with Desvincular (revokes the device's credential). */
export function DevicesList({ title, platforms, empty, unpairMessage }: DevicesListProps) {
  const devices = useDeviceTokens()
  const [unpairing, setUnpairing] = useState<Token | null>(null)
  const items = (devices.data?.items ?? []).filter(
    (token) => !token.revoked_at && token.platform !== null && platforms.includes(token.platform),
  )

  return (
    <section className={styles.devices} aria-label={title}>
      <h4>{title}</h4>
      {devices.isPending && <p role="status">Carregando aparelhos…</p>}
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
                Pareado em {dayMonth.format(new Date(token.created_at))} ·{' '}
                {token.last_used_at ? `última sincronização ${formatSync(token.last_used_at)}` : 'ainda sem sincronização'}
              </span>
              <span className="list-row-actions">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm btn-danger"
                  onClick={() => setUnpairing(token)}
                  aria-label={`Desvincular ${token.name}`}
                >
                  Desvincular
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
      title={`Desvincular ${token.name}?`}
      confirmLabel="Desvincular"
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
