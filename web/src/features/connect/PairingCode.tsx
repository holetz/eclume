import { CopyValue } from '../../app/CopyValue'
import styles from './Connect.module.css'
import { usePairingState, type Pairing } from './pairing'

interface PairingCodeProps {
  pairing: Pairing
  onRegenerate: () => void
  regenerating?: boolean
}

/** The pairing code to type into the app: the value to copy, the expiry and the outcome. */
export function PairingCode({ pairing, onRegenerate, regenerating = false }: PairingCodeProps) {
  const state = usePairingState(pairing)

  return (
    <div className={styles.pairing}>
      {state.phase === 'used' ? (
        <p className="alert alert-success">
          <span className="alert-title">Pareado{state.deviceName ? `: ${state.deviceName}` : ''}</span>
        </p>
      ) : (
        <>
          <CopyValue value={pairing.code.display ?? pairing.code.code ?? ''} size="lg" />
          {state.phase === 'pending' ? (
            <span className="text-muted" aria-live="off">
              Vale por {state.left}
            </span>
          ) : (
            <div className={styles.expired}>
              <span>Código vencido</span>
              <button type="button" className="btn btn-secondary btn-sm" onClick={onRegenerate} disabled={regenerating}>
                Gerar outro
              </button>
            </div>
          )}
        </>
      )}
      <span className="visually-hidden" role="status" aria-label="Validade do código">
        {state.announce}
      </span>
    </div>
  )
}
