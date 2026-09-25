import { Link } from 'react-router'
import { usePageTitle } from '../../app/usePageTitle'
import styles from './DesktopPage.module.css'
import { detectOs, PLATFORMS } from './links'

export function DesktopPage() {
  usePageTitle('App desktop')
  const current = detectOs(navigator.userAgent)
  const platforms = [...PLATFORMS].sort((a, b) => Number(b.os === current) - Number(a.os === current))

  return (
    <section className={styles.page} aria-labelledby="desktop-titulo">
      <header className={styles.header}>
        <h1 id="desktop-titulo">App desktop</h1>
        <p className="muted">
          O app fica na bandeja do sistema, percebe quando uma reunião do Teams, Meet ou Zoom começa, grava o microfone e
          o áudio do computador e envia para o eclume quando a reunião termina. A transcrição acontece no servidor.
        </p>
      </header>

      <ul className={styles.platforms} aria-label="Sistemas">
        {platforms.map((platform) => (
          <li
            key={platform.os}
            className={`card ${styles.platform}`}
            aria-labelledby={`os-${platform.os}`}
            data-current={platform.os === current}
          >
            <div className={styles.platformHead}>
              <h2 id={`os-${platform.os}`}>{platform.name}</h2>
              {platform.os === current && <span className="badge badge-progress">Este computador</span>}
            </div>
            <p className="muted">{platform.requirements}</p>
            <ul className={styles.installers}>
              {platform.installers.map((installer) => (
                <li key={installer.label}>
                  {installer.href ? (
                    <a className="btn btn-primary" href={installer.href} download>
                      Baixar {installer.label}
                    </a>
                  ) : (
                    <span className={styles.unavailable}>
                      {installer.label} <span className="muted">· ainda não publicado</span>
                    </span>
                  )}
                </li>
              ))}
            </ul>
            <p className={styles.note}>{platform.firstRun}</p>
          </li>
        ))}
      </ul>

      <section className={`card ${styles.setup}`} aria-labelledby="desktop-configurar">
        <h2 id="desktop-configurar">Depois de instalar</h2>
        <ol>
          <li>
            Crie um <Link to="/tokens">token de acesso</Link> com a combinação “App desktop” (ler e enviar gravações).
          </li>
          <li>
            No app, informe o endereço do servidor, <code>{window.location.origin}</code>, e cole o token.
          </li>
          <li>As reuniões gravadas aparecem na biblioteca assim que o envio termina.</li>
        </ol>
      </section>
    </section>
  )
}
