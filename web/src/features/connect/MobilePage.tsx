import { useCallback, useEffect, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { errorMessage } from '../../api/problem'
import { useHelpTopic } from '../../app/help'
import { PageHead } from '../../app/PageHead'
import styles from './Connect.module.css'
import { DevicesList } from './DevicesList'
import { useCreatePairingCode, usePairingState, type Pairing } from './pairing'
import { QrCode } from './QrCode'

export function MobilePage() {
  useHelpTopic('app-movel')
  const { t } = useTranslation(['connect', 'common'])
  const create = useCreatePairingCode()
  const { mutate } = create
  // The last code stays on screen while another is generated (the mutation's `data` resets on each request).
  const [pairing, setPairing] = useState<Pairing | null>(null)
  const generate = useCallback(() => mutate(undefined, { onSuccess: setPairing }), [mutate])
  // Each page generates its own code on opening: a new code voids the previous one.
  useEffect(generate, [generate])

  return (
    <section className={styles.page}>
      <PageHead kicker={t('kicker')} title={t('mobile.title')} />
      <p className={styles.lead}>{t('mobile.lead')}</p>
      {create.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(create.error)}{' '}
          <button type="button" className="btn btn-secondary btn-sm" onClick={generate}>
            {t('common:retry')}
          </button>
        </p>
      )}
      {pairing ? (
        <MobilePairing key={pairing.code.id} pairing={pairing} onRegenerate={generate} regenerating={create.isPending} />
      ) : (
        !create.isError && <p role="status">{t('mobile.generating')}</p>
      )}
      <DevicesList
        title={t('mobile.devices')}
        platforms={['ios', 'android']}
        empty={t('mobile.empty')}
        unpairMessage={t('mobile.unpair')}
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
  const { t } = useTranslation('connect')
  const state = usePairingState(pairing)
  const display = pairing.code.display ?? pairing.code.code

  return (
    <>
      <div className={styles.mobileGrid}>
        {state.phase === 'pending' && pairing.code.pair_url ? (
          <QrCode value={pairing.code.pair_url} label={t('mobile.qr')} />
        ) : (
          <div className={`qr-slot ${styles.qrDone}`}>
            {state.phase === 'used'
              ? t('pairing.paired')
              : state.phase === 'expired'
                ? t('pairing.expired')
                : t('mobile.typeCode')}
          </div>
        )}
        <ol className="steps">
          <li>
            <strong>{t('mobile.install')}</strong>
          </li>
          <li>
            <strong>{t('mobile.tap')}</strong>
            <span className="text-muted">{t('mobile.tapText')}</span>
          </li>
          <li>
            <strong>{t('mobile.point')}</strong>
            {state.phase === 'pending' && (
              <span className="text-muted" aria-live="off">
                {t('mobile.validFor', { left: state.left })}
              </span>
            )}
            {state.phase === 'expired' && <span className="text-muted">{t('pairing.expired')}</span>}
          </li>
        </ol>
      </div>
      {state.phase === 'used' && (
        <p className="alert alert-success">
          <span className="alert-title">
            {state.deviceName ? t('pairing.pairedName', { name: state.deviceName }) : t('pairing.paired')}
          </span>
        </p>
      )}
      <div className={styles.codeRow}>
        {state.phase === 'pending' && (
          <span>
            <Trans
              t={t}
              i18nKey="mobile.noCamera"
              values={{ code: display ?? '' }}
              components={{ code: <strong className="mono" /> }}
            />
          </span>
        )}
        <button type="button" className="btn btn-secondary btn-sm" onClick={onRegenerate} disabled={regenerating}>
          {t('mobile.another')}
        </button>
      </div>
      <span className="visually-hidden" role="status" aria-label={t('pairing.validity')}>
        {state.announce}
      </span>
    </>
  )
}
