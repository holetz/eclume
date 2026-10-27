import { useCallback, useEffect, useState } from 'react'
import { errorMessage } from '../../api/problem'
import { useHelpTopic } from '../../app/help'
import { PageHead } from '../../app/PageHead'
import styles from './Connect.module.css'
import { DevicesList } from './DevicesList'
import { useCreatePairingCode, usePairingState, type Pairing } from './pairing'
import { QrCode } from './QrCode'

export function MobilePage() {
  useHelpTopic('app-movel')
  const create = useCreatePairingCode()
  const { mutate } = create
  // The last code stays on screen while another is generated (the mutation's `data` resets on each request).
  const [pairing, setPairing] = useState<Pairing | null>(null)
  const generate = useCallback(() => mutate(undefined, { onSuccess: setPairing }), [mutate])
  // Each page generates its own code on opening: a new code voids the previous one.
  useEffect(generate, [generate])

  return (
    <section className={styles.page}>
      <PageHead kicker="Minhas configurações" title="App móvel" />
      <p className={styles.lead}>
        Use o celular como gravador portátil. Ele grava sem rede e sincroniza pelo Wi-Fi quando volta a esta rede.
      </p>
      {create.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(create.error)}{' '}
          <button type="button" className="btn btn-secondary btn-sm" onClick={generate}>
            Tentar de novo
          </button>
        </p>
      )}
      {pairing ? (
        <MobilePairing key={pairing.code.id} pairing={pairing} onRegenerate={generate} regenerating={create.isPending} />
      ) : (
        !create.isError && <p role="status">Gerando o código…</p>
      )}
      <DevicesList
        title="Celulares vinculados"
        platforms={['ios', 'android']}
        empty="Nenhum celular vinculado ainda."
        unpairMessage="O celular para de sincronizar até entrar de novo."
      />
    </section>
  )
}

function MobilePairing({
  pairing,
  onRegenerate,
  regenerating,
}: {
  pairing: Pairing
  onRegenerate: () => void
  regenerating: boolean
}) {
  const state = usePairingState(pairing)
  const display = pairing.code.display ?? pairing.code.code

  return (
    <>
      <div className={styles.mobileGrid}>
        {state.phase === 'pending' && pairing.code.pair_url ? (
          <QrCode value={pairing.code.pair_url} label="Código QR para parear o celular" />
        ) : (
          <div className={`qr-slot ${styles.qrDone}`}>
            {state.phase === 'used' ? 'Pareado' : state.phase === 'expired' ? 'Código vencido' : 'Digite o código no app'}
          </div>
        )}
        <ol className="steps">
          <li>
            <strong>Instale o eclume no celular</strong>
          </li>
          <li>
            <strong>Toque em Ler um código</strong>
            <span className="text-muted">Na primeira tela do app.</span>
          </li>
          <li>
            <strong>Aponte a câmera aqui</strong>
            {state.phase === 'pending' && (
              <span className="text-muted" aria-live="off">
                Válido por {state.left}
              </span>
            )}
            {state.phase === 'expired' && <span className="text-muted">Código vencido</span>}
          </li>
        </ol>
      </div>
      {state.phase === 'used' && (
        <p className="alert alert-success">
          <span className="alert-title">Pareado{state.deviceName ? `: ${state.deviceName}` : ''}</span>
        </p>
      )}
      <div className={styles.codeRow}>
        {state.phase === 'pending' && (
          <span>
            Sem câmera? Digite <strong className="mono">{display}</strong> no app.
          </span>
        )}
        <button type="button" className="btn btn-secondary btn-sm" onClick={onRegenerate} disabled={regenerating}>
          Gerar outro código
        </button>
      </div>
      <span className="visually-hidden" role="status" aria-label="Validade do código">
        {state.announce}
      </span>
    </>
  )
}
