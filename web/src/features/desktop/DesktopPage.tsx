import { Download } from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import { errorMessage } from '../../api/problem'
import { useHelpTopic } from '../../app/help'
import { PageHead } from '../../app/PageHead'
import { DevicesList } from '../connect/DevicesList'
import { useCreatePairingCode } from '../connect/pairing'
import { PairingCode } from '../connect/PairingCode'

import styles from './DesktopPage.module.css'
import { detectOs, PLATFORMS, typeLabel, useInstallers, type Installer, type Platform } from './installers'
import { formatBytes } from '../../shared/format'

export function DesktopPage() {
  useHelpTopic('app-desktop')
  const { t } = useTranslation('desktop')
  const current = detectOs(navigator.userAgent)
  const platforms = [...PLATFORMS].sort((a, b) => Number(b.os === current) - Number(a.os === current))
  const installers = useInstallers()
  const pairing = useCreatePairingCode()

  return (
    <section className={styles.page}>
      <PageHead kicker={t('kicker')} title={t('title')} />
      <p className={styles.lead}>{t('lead')}</p>

      <ul className={styles.platforms} aria-label={t('systems')}>
        {platforms.map((platform) => (
          <PlatformCard
            key={platform.os}
            platform={platform}
            loading={installers.isPending}
            installers={installers.data?.instaladores.filter((i) => i.plataforma === platform.os) ?? null}
          />
        ))}
      </ul>

      <section className={styles.link} aria-labelledby="desktop-vincular">
        <h4 id="desktop-vincular">{t('link.title')}</h4>
        <p className="text-muted">{t('link.text')}</p>
        {pairing.data ? (
          <PairingCode
            key={pairing.data.code.id}
            pairing={pairing.data}
            onRegenerate={() => pairing.mutate()}
            regenerating={pairing.isPending}
          />
        ) : (
          <div>
            <button type="button" className="btn btn-secondary" onClick={() => pairing.mutate()} disabled={pairing.isPending}>
              {t('link.generate')}
            </button>
          </div>
        )}
        {pairing.isError && (
          <p className="alert alert-error" role="alert">
            {errorMessage(pairing.error)}
          </p>
        )}
      </section>

      <DevicesList
        title={t('devices')}
        platforms={['windows', 'macos', 'linux']}
        empty={t('empty')}
        unpairMessage={t('unpair')}
      />
    </section>
  )
}

function PlatformCard({
  platform,
  loading,
  installers,
}: {
  platform: Platform
  loading: boolean
  installers: Installer[] | null
}) {
  const { t } = useTranslation('desktop')
  const recommended = installers?.find((i) => i.recomendado) ?? installers?.[0]
  const others = installers?.filter((i) => i !== recommended) ?? []

  return (
    <li className={`card ${styles.card}`} aria-labelledby={`os-${platform.os}`}>
      <span className="card-title" id={`os-${platform.os}`}>
        {platform.name}
      </span>
      <span className="card-body">{platform.requirements}</span>
      {loading ? (
        <span className="text-muted">{t('searching')}</span>
      ) : recommended ? (
        <>
          <span className={`mono text-muted ${styles.file}`}>{recommended.arquivo}</span>
          <a className={`btn btn-primary ${styles.download}`} href={recommended.url} download>
            <Download size={14} aria-hidden />
            <Trans
              t={t}
              i18nKey="download"
              values={{ platform: platform.name }}
              components={{ hidden: <span className="visually-hidden" /> }}
            />
          </a>
          {others.length > 0 && (
            <span className={styles.others}>
              {others.map((i) => (
                <a key={i.arquivo} href={i.url} download>
                  {typeLabel(i.tipo) ?? i.tipo} · {formatBytes(i.tamanho)}
                </a>
              ))}
            </span>
          )}
        </>
      ) : (
        <span className="text-muted">{t('unpublished')}</span>
      )}
      <details className="disclosure">
        <summary>{t('firstTime')}</summary>
        <p className={styles.note}>{platform.firstRun}</p>
      </details>
    </li>
  )
}
