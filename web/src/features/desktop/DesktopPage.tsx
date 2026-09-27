import { Download } from 'lucide-react'
import { errorMessage } from '../../api/problem'
import { useHelpTopic } from '../../app/help'
import { PageHead } from '../../app/PageHead'
import { DevicesList } from '../connect/DevicesList'
import { useCreatePairingCode } from '../connect/pairing'
import { PairingCode } from '../connect/PairingCode'
import { formatBytes } from '../library/format'
import styles from './DesktopPage.module.css'
import { detectOs, PLATFORMS, TYPE_LABELS, useInstallers, type Installer, type Platform } from './installers'

export function DesktopPage() {
  useHelpTopic('app-desktop')
  const current = detectOs(navigator.userAgent)
  const platforms = [...PLATFORMS].sort((a, b) => Number(b.os === current) - Number(a.os === current))
  const installers = useInstallers()
  const pairing = useCreatePairingCode()

  return (
    <section className={styles.page}>
      <PageHead kicker="Minhas configurações" title="App desktop" />
      <p className={styles.lead}>
        Grava reuniões e notas de voz no computador e envia para este servidor. O instalador abaixo já conhece este
        servidor: você só entra com seu e-mail e senha.
      </p>

      <ul className={styles.platforms} aria-label="Sistemas">
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
        <h4 id="desktop-vincular">Instalou de outro lugar?</h4>
        <p className="text-muted">
          Abra o app, escolha Vincular com um código e digite este código. Ele vence em 10 minutos.
        </p>
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
              Gerar código de vínculo
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
        title="Computadores vinculados"
        platforms={['windows', 'macos', 'linux']}
        empty="Nenhum computador vinculado ainda."
        unpairMessage="O computador para de enviar gravações até entrar de novo."
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
  const recommended = installers?.find((i) => i.recomendado) ?? installers?.[0]
  const others = installers?.filter((i) => i !== recommended) ?? []

  return (
    <li className={`card ${styles.card}`} aria-labelledby={`os-${platform.os}`}>
      <span className="card-title" id={`os-${platform.os}`}>
        {platform.name}
      </span>
      <span className="card-body">{platform.requirements}</span>
      {loading ? (
        <span className="text-muted">Procurando os instaladores…</span>
      ) : recommended ? (
        <>
          <span className={`mono text-muted ${styles.file}`}>{recommended.arquivo}</span>
          <a className={`btn btn-primary ${styles.download}`} href={recommended.url} download>
            <Download size={14} aria-hidden />
            Baixar <span className="visually-hidden">para {platform.name}</span>
          </a>
          {others.length > 0 && (
            <span className={styles.others}>
              {others.map((i) => (
                <a key={i.arquivo} href={i.url} download>
                  {TYPE_LABELS[i.tipo] ?? i.tipo} · {formatBytes(i.tamanho)}
                </a>
              ))}
            </span>
          )}
        </>
      ) : (
        <span className="text-muted">Os instaladores ainda não foram publicados neste servidor.</span>
      )}
      <details className="disclosure">
        <summary>Primeira vez?</summary>
        <p className={styles.note}>{platform.firstRun}</p>
      </details>
    </li>
  )
}
